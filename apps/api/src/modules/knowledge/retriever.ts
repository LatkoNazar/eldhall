import { createHash } from 'node:crypto';
import { chunkMarkdown, terms } from './text.js';
import { cosine, HashingEmbedder, type Embedder } from './embeddings.js';
import type { VectorStore } from './vector-store.js';

/**
 * Universal knowledge retrieval over the published support_knowledge rows.
 *
 * The support store stays the single source of truth (versions, publish/revoke, business scope,
 * sourceRefs validation). This module turns the published snapshot of one turn into ranked passages:
 * heading-aware chunks -> BM25 (UA/EN terms) + cosine over embeddings -> Reciprocal Rank Fusion ->
 * at most two passages per document, filtered by audience and customer plan.
 *
 * Vectors: local hashing embedder by default, or OpenAI/Google (KB_EMBEDDINGS_PROVIDER). With the
 * Postgres store and pgvector available they persist in support_knowledge_chunks (HNSW search);
 * otherwise they live in an in-process cache keyed by (id, version, content hash). If the embedding
 * model fails, search degrades to lexical-only instead of failing the turn.
 */

export type KnowledgeAudience = 'customer' | 'internal';
export interface KnowledgeDoc { id: string; title: string; content: string; version: number; category?: string; businessId?: string; audience?: KnowledgeAudience; plans?: string[]; sourceUrl?: string | null }
export interface KnowledgeSearchOptions { k?: number; perDocument?: number; /** 'customer' hides internal documents (default for the agent). */ audience?: 'customer' | 'any'; /** Only documents for all plans or for this plan. */ plan?: string }

export interface KnowledgePassage { section: string; text: string; score: number; lexicalRank: number | null; vectorRank: number | null; similarity: number | null }

/** One document per hit. `content` holds only the matched passages, `passages` explains the ranking. */
export interface KnowledgeHit {
  id: string;
  title: string;
  version: number;
  category?: string;
  audience: KnowledgeAudience;
  sourceUrl: string | null;
  content: string;
  section: string;
  score: number;
  passages: KnowledgePassage[];
}

export interface KnowledgeSearchResult { query: string; mode: 'hybrid' | 'lexical'; embedder: string; tookMs: number; hits: KnowledgeHit[] }
export interface KnowledgeIndexStatus { embedder: { id: string; provider: string; model: string; dimensions: number }; vectorStore: 'pgvector' | 'memory'; cachedDocuments: number; chunks: number | null; staleChunks: number | null }

interface IndexedChunk { docId: string; ord: number; section: string; body: string; terms: string[]; vector: number[] | null }

export const RRF_K = 60;
export const MIN_RELATIVE_SCORE = 0.6;
const MAX_CACHED_DOCS = 5000;

export class KnowledgeRetriever {
  private readonly cache = new Map<string, IndexedChunk[]>();

  constructor(readonly embedder: Embedder = new HashingEmbedder(), readonly vectors: VectorStore | null = null, private readonly log: (message: string) => void = () => undefined) {}

  /** Documents ranked by their best passage. k = number of documents (the harness and DSH read up to 5). */
  async search(docs: readonly KnowledgeDoc[], query: string, options: KnowledgeSearchOptions = {}): Promise<KnowledgeHit[]> {
    return (await this.explain(docs, query, options)).hits;
  }

  async explain(all: readonly KnowledgeDoc[], query: string, { k = 5, perDocument = 2, audience = 'customer', plan }: KnowledgeSearchOptions = {}): Promise<KnowledgeSearchResult> {
    const started = Date.now();
    let mode: KnowledgeSearchResult['mode'] = 'hybrid';
    const done = (hits: KnowledgeHit[]): KnowledgeSearchResult => ({ query, mode, embedder: this.embedder.id, tookMs: Date.now() - started, hits });
    const docs = all.filter(doc => (audience === 'any' || (doc.audience ?? 'customer') === 'customer') && (!doc.plans?.length || (plan !== undefined && doc.plans.includes(plan))));
    const queryTerms = terms(query);
    if (!queryTerms.length || !docs.length) return done([]);
    const byId = new Map(docs.map(doc => [doc.id, doc]));
    const chunks = (await Promise.all(docs.map(doc => this.indexed(doc)))).flat();

    const lexical = bm25(chunks, queryTerms);
    let vector: { chunk: IndexedChunk; similarity: number }[] = [];
    try {
      const [queryVector] = await this.embedder.embed([query], 'query');
      vector = await this.nearest(docs, chunks, queryVector!);
    } catch (error) {
      mode = 'lexical';
      this.log(`knowledge: query embedding failed, lexical only (${error instanceof Error ? error.message : 'error'})`);
    }
    const fused = fuse(lexical, vector, this.embedder.minSimilarity);
    // Tail cut: when a passage is confirmed by both signals, single-signal stragglers far below it are
    // noise ("місяць" matches every pricing page). Keeps the model context and sourceRefs tight.
    const ranked = fused.filter(hit => hit.score >= fused[0]!.score * MIN_RELATIVE_SCORE);

    const hits = new Map<string, KnowledgeHit>();
    for (const hit of ranked) {
      const doc = byId.get(hit.chunk.docId)!;
      const passage: KnowledgePassage = { section: hit.chunk.section, text: hit.chunk.body, score: round(hit.score, 4), lexicalRank: hit.lexicalRank, vectorRank: hit.vectorRank, similarity: hit.similarity === null ? null : round(hit.similarity, 3) };
      const existing = hits.get(doc.id);
      if (existing) {
        if (existing.passages.length < perDocument) existing.passages.push(passage);
        continue;
      }
      if (hits.size >= k) continue;
      hits.set(doc.id, { id: doc.id, title: doc.title, version: doc.version, ...(doc.category ? { category: doc.category } : {}), audience: doc.audience ?? 'customer', sourceUrl: doc.sourceUrl ?? null, content: '', section: passage.section, score: passage.score, passages: [passage] });
    }
    for (const hit of hits.values()) {
      const ord = (p: KnowledgePassage) => chunks.find(c => c.docId === hit.id && c.body === p.text)?.ord ?? 0;
      const ordered = [...hit.passages].sort((a, b) => ord(a) - ord(b));
      hit.content = ordered.map(p => (ordered.length > 1 ? `${p.section}\n${p.text}` : p.text)).join('\n\n');
    }
    return done([...hits.values()]);
  }

  /** Re-embeds the given published documents with the current embedder and drops vectors of other embedders. */
  async reindex(docs: readonly KnowledgeDoc[]): Promise<{ documents: number; chunks: number; embedder: string }> {
    for (const doc of docs) for (const key of [...this.cache.keys()]) if (key.startsWith(`${doc.id}:`)) this.cache.delete(key);
    await this.vectors?.clear(this.embedder.id);
    let chunks = 0;
    for (const doc of docs) chunks += (await this.indexed(doc, true)).length;
    return { documents: docs.length, chunks, embedder: this.embedder.id };
  }

  async status(): Promise<KnowledgeIndexStatus> {
    const stats = this.vectors ? await this.vectors.stats(this.embedder.id) : null;
    return {
      embedder: { id: this.embedder.id, provider: this.embedder.provider, model: this.embedder.model, dimensions: this.embedder.dimensions },
      vectorStore: this.vectors ? 'pgvector' : 'memory', cachedDocuments: this.cache.size,
      chunks: stats?.chunks ?? [...this.cache.values()].reduce((sum, list) => sum + list.length, 0), staleChunks: stats?.staleChunks ?? 0,
    };
  }

  /** Number of cached document versions (for diagnostics and tests). */
  get cachedDocuments(): number { return this.cache.size; }

  private async nearest(docs: KnowledgeDoc[], chunks: IndexedChunk[], query: number[]): Promise<{ chunk: IndexedChunk; similarity: number }[]> {
    if (this.vectors && chunks.every(chunk => chunk.vector)) {
      const byKey = new Map(chunks.map(chunk => [`${chunk.docId}:${chunk.ord}`, chunk]));
      const rows = await this.vectors.nearest(docs.map(d => ({ id: d.id, version: d.version })), this.embedder.id, query, 50);
      const found = rows.flatMap(row => { const chunk = byKey.get(`${row.knowledgeId}:${row.ord}`); return chunk ? [{ chunk, similarity: row.similarity }] : []; });
      if (found.length || !chunks.length) return found;
    }
    return chunks.filter(chunk => chunk.vector).map(chunk => ({ chunk, similarity: cosine(query, chunk.vector!) })).sort((a, b) => b.similarity - a.similarity).slice(0, 50);
  }

  private async indexed(doc: KnowledgeDoc, force = false): Promise<IndexedChunk[]> {
    const hash = createHash('sha256').update(`${doc.title}\n${doc.content}`).digest('hex');
    const key = `${doc.id}:${doc.version}:${hash}`;
    const cached = this.cache.get(key);
    if (cached && !force) return cached;
    const drafts = chunkMarkdown(doc.title, doc.content);
    const base = drafts.map(d => ({ docId: doc.id, ord: d.ord, section: d.headingPath, body: d.body, terms: d.terms }));
    let vectors: (number[] | null)[] | null = null;
    if (this.vectors && !force) {
      try {
        const stored = await this.vectors.load(doc.id, doc.version, this.embedder.id, hash);
        if (stored && stored.length === base.length) vectors = stored.map(s => s.vector);
      } catch (error) { this.log(`knowledge: vector load failed (${error instanceof Error ? error.message : 'error'})`); }
    }
    let complete = true;
    if (!vectors) {
      try {
        vectors = await this.embedder.embed(drafts.map(d => `${d.headingPath}\n${d.body}`), 'document');
        if (this.vectors && doc.businessId) {
          await this.vectors.save(doc.id, doc.businessId, doc.version, this.embedder.id, hash, base.map((c, i) => ({ ord: c.ord, section: c.section, body: c.body, contentHash: hash, vector: vectors![i]! })))
            .catch(error => this.log(`knowledge: vector save failed (${error instanceof Error ? error.message : 'error'})`));
        }
      } catch (error) {
        // The embedding model is unavailable: index lexically now, retry the vectors next turn.
        complete = false;
        vectors = base.map(() => null);
        this.log(`knowledge: document embedding failed (${error instanceof Error ? error.message : 'error'})`);
      }
    }
    const chunks = base.map((c, i) => ({ ...c, vector: vectors![i] ?? null }));
    if (!complete) return chunks;
    for (const old of [...this.cache.keys()]) if (old.startsWith(`${doc.id}:`)) this.cache.delete(old);
    if (this.cache.size >= MAX_CACHED_DOCS) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, chunks);
    return chunks;
  }
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

export function bm25(candidates: IndexedChunk[], queryTerms: string[]): { chunk: IndexedChunk; score: number }[] {
  const unique = [...new Set(queryTerms)];
  if (!unique.length || !candidates.length) return [];
  const n = candidates.length;
  const avgdl = candidates.reduce((sum, c) => sum + c.terms.length, 0) / n || 1;
  const df = new Map(unique.map(t => [t, candidates.filter(c => c.terms.includes(t)).length]));
  return candidates.map(chunk => {
    let score = 0;
    for (const term of unique) {
      const tf = chunk.terms.filter(t => t === term).length;
      if (!tf) continue;
      const d = df.get(term)!;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * chunk.terms.length / avgdl));
    }
    return { chunk, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
}

interface Ranked { chunk: IndexedChunk; lexicalRank: number | null; vectorRank: number | null; similarity: number | null; score: number }

/** Reciprocal Rank Fusion. A vector-only hit must clear the embedder's similarity floor; a lexical hit already matched a term. */
function fuse(lexical: { chunk: IndexedChunk; score: number }[], vector: { chunk: IndexedChunk; similarity: number }[], minSimilarity: number): Ranked[] {
  const byChunk = new Map<IndexedChunk, Ranked>();
  lexical.forEach((hit, index) => byChunk.set(hit.chunk, { chunk: hit.chunk, lexicalRank: index + 1, vectorRank: null, similarity: null, score: 1 / (RRF_K + index + 1) }));
  vector.forEach((hit, index) => {
    const existing = byChunk.get(hit.chunk);
    if (existing) {
      existing.vectorRank = index + 1;
      existing.similarity = hit.similarity;
      if (hit.similarity >= minSimilarity) existing.score += 1 / (RRF_K + index + 1);
    } else if (hit.similarity >= minSimilarity) {
      byChunk.set(hit.chunk, { chunk: hit.chunk, lexicalRank: null, vectorRank: index + 1, similarity: hit.similarity, score: 1 / (RRF_K + index + 1) });
    }
  });
  return [...byChunk.values()].sort((a, b) => b.score - a.score || (a.lexicalRank ?? 99) - (b.lexicalRank ?? 99));
}
