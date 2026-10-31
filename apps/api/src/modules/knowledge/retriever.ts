import { createHash } from 'node:crypto';
import { chunkMarkdown, terms } from './text.js';
import { cosine, HashingEmbedder, type Embedder } from './embeddings.js';

/**
 * Universal knowledge retrieval over the published support_knowledge rows.
 *
 * The support store stays the single source of truth (versions, publish/revoke, business scope,
 * sourceRefs validation). This module only turns the published snapshot of one turn into ranked
 * passages: heading-aware chunks -> BM25 (UA/EN terms) + cosine over local embeddings -> Reciprocal
 * Rank Fusion -> at most two passages per document. The index is an in-process cache keyed by
 * (id, version, content hash), so a publish or revoke is picked up on the next turn without a
 * reindex job, and no vector database is needed for the MVP.
 */

export interface KnowledgeDoc { id: string; title: string; content: string; version: number; category?: string }

export interface KnowledgePassage { section: string; text: string; score: number; lexicalRank: number | null; vectorRank: number | null; similarity: number | null }

/** One document per hit. `content` holds only the matched passages, `passages` explains the ranking. */
export interface KnowledgeHit {
  id: string;
  title: string;
  version: number;
  category?: string;
  content: string;
  section: string;
  score: number;
  passages: KnowledgePassage[];
}

export interface KnowledgeSearchResult { query: string; mode: 'hybrid'; embedder: string; tookMs: number; hits: KnowledgeHit[] }

interface IndexedChunk { docId: string; ord: number; section: string; body: string; terms: string[]; vector: number[] }

export const RRF_K = 60;
const MAX_CACHED_DOCS = 5000;
export const MIN_RELATIVE_SCORE = 0.6;

export class KnowledgeRetriever {
  readonly mode = 'hybrid' as const;
  private readonly cache = new Map<string, IndexedChunk[]>();

  constructor(readonly embedder: Embedder = new HashingEmbedder()) {}

  /** Documents ranked by their best passage. k = number of documents (the harness and DSH read up to 5). */
  async search(docs: readonly KnowledgeDoc[], query: string, options: { k?: number; perDocument?: number } = {}): Promise<KnowledgeHit[]> {
    return (await this.explain(docs, query, options)).hits;
  }

  async explain(docs: readonly KnowledgeDoc[], query: string, { k = 5, perDocument = 2 }: { k?: number; perDocument?: number } = {}): Promise<KnowledgeSearchResult> {
    const started = Date.now();
    const done = (hits: KnowledgeHit[]): KnowledgeSearchResult => ({ query, mode: this.mode, embedder: this.embedder.id, tookMs: Date.now() - started, hits });
    const queryTerms = terms(query);
    if (!queryTerms.length || !docs.length) return done([]);
    const byId = new Map(docs.map(doc => [doc.id, doc]));
    const chunks = (await Promise.all(docs.map(doc => this.indexed(doc)))).flat();

    const lexical = bm25(chunks, queryTerms);
    const [queryVector] = await this.embedder.embed([query], 'query');
    const vector = chunks.map(chunk => ({ chunk, similarity: cosine(queryVector!, chunk.vector) })).sort((a, b) => b.similarity - a.similarity).slice(0, 50);
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
      hits.set(doc.id, { id: doc.id, title: doc.title, version: doc.version, ...(doc.category ? { category: doc.category } : {}), content: '', section: passage.section, score: passage.score, passages: [passage] });
    }
    for (const hit of hits.values()) {
      // Keep the document order of the passages so the text reads naturally.
      const ordered = [...hit.passages].sort((a, b) => order(chunks, hit.id, a) - order(chunks, hit.id, b));
      hit.content = ordered.map(p => (ordered.length > 1 ? `${p.section}\n${p.text}` : p.text)).join('\n\n');
    }
    return done([...hits.values()]);
  }

  /** Number of cached document versions (for diagnostics and tests). */
  get cachedDocuments(): number { return this.cache.size; }

  private async indexed(doc: KnowledgeDoc): Promise<IndexedChunk[]> {
    const key = `${doc.id}:${doc.version}:${createHash('sha256').update(`${doc.title}\n${doc.content}`).digest('hex')}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const drafts = chunkMarkdown(doc.title, doc.content);
    const vectors = await this.embedder.embed(drafts.map(d => `${d.headingPath}\n${d.body}`), 'document');
    const chunks = drafts.map((d, i) => ({ docId: doc.id, ord: d.ord, section: d.headingPath, body: d.body, terms: d.terms, vector: vectors[i]! }));
    for (const old of this.cache.keys()) if (old.startsWith(`${doc.id}:`)) this.cache.delete(old);
    if (this.cache.size >= MAX_CACHED_DOCS) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, chunks);
    return chunks;
  }
}

/** Process-wide instance shared by the harness and the operator search route, so both see one cache. */
export const knowledgeRetriever = new KnowledgeRetriever();

function order(chunks: IndexedChunk[], docId: string, passage: KnowledgePassage): number {
  return chunks.find(c => c.docId === docId && c.body === passage.text)?.ord ?? 0;
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
