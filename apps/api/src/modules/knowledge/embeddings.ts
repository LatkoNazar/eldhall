import { terms } from './text.js';

export const KB_DIMENSIONS = 768;
export type EmbeddingProvider = 'local' | 'openai' | 'google';

export interface Embedder {
  /** provider:model:dimensions — vectors are only comparable within one id (the index version). */
  readonly id: string;
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly dimensions: number;
  /** Cosine similarity below which a vector-only match is treated as noise. Model specific. */
  readonly minSimilarity: number;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
}

/**
 * Deterministic local embedder: signed feature hashing of search terms (weight 1) and character
 * trigrams of each term (weight 0.35), L2-normalised. No network and no key, so tests, the demo and a
 * key-less deployment still get a working vector signal next to BM25.
 * Cross-lingual recall comes from the synonym canonicalisation in terms(); trigrams absorb
 * inflections the stemmer misses. A hosted embedding model can replace it behind the same interface.
 */
export class HashingEmbedder implements Embedder {
  readonly provider: EmbeddingProvider = 'local';
  readonly model = 'hashing-v1';
  readonly dimensions: number;
  readonly id: string;
  readonly minSimilarity = 0.22;

  constructor(dimensions = KB_DIMENSIONS) {
    this.dimensions = dimensions;
    this.id = `local:hashing-v1:${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.vector(text));
  }

  vector(text: string): number[] {
    const out = new Array<number>(this.dimensions).fill(0);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      out[h % this.dimensions]! += (h & 0x80000000 ? -1 : 1) * weight;
    };
    for (const term of terms(text)) {
      add(`t:${term}`, 1);
      const padded = `^${term}$`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`g:${padded.slice(i, i + 3)}`, 0.35);
    }
    return normalize(out);
  }
}

/**
 * Hosted embeddings over plain HTTPS (no SDK dependency): OpenAI `/v1/embeddings` or Google
 * `batchEmbedContents`, both reduced to KB_DIMENSIONS by the provider so pgvector keeps one column type.
 * Keys come from Settings (root .env), never from process.env or the browser.
 */
export class RemoteEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions = KB_DIMENSIONS;
  readonly minSimilarity: number;
  constructor(readonly provider: 'openai' | 'google', readonly model: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000) {
    if (!apiKey) throw new Error(`KB_EMBEDDINGS_PROVIDER=${provider} needs an API key`);
    this.id = `${provider}:${model}:${KB_DIMENSIONS}`;
    this.minSimilarity = provider === 'openai' ? 0.3 : 0.5;
  }

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) out.push(...await this.batch(texts.slice(i, i + 64), purpose));
    for (const vector of out) if (vector.length !== KB_DIMENSIONS) throw new Error(`Embedding model returned ${vector.length} dimensions, expected ${KB_DIMENSIONS}`);
    return out.map(normalize);
  }

  private async batch(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    if (this.provider === 'openai') {
      const response = await this.fetcher('https://api.openai.com/v1/embeddings', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` }, body: JSON.stringify({ model: this.model, input: texts, dimensions: KB_DIMENSIONS }) });
      if (!response.ok) throw new Error(`OpenAI embeddings failed (${response.status})`);
      const body = await response.json() as { data: { index: number; embedding: number[] }[] };
      return [...body.data].sort((a, b) => a.index - b.index).map(item => item.embedding);
    }
    const response = await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:batchEmbedContents`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${this.model}`, content: { parts: [{ text }] }, taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: KB_DIMENSIONS })) }),
    });
    if (!response.ok) throw new Error(`Google embeddings failed (${response.status})`);
    const body = await response.json() as { embeddings: { values: number[] }[] };
    return body.embeddings.map(item => item.values);
  }
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = { local: 'hashing-v1', openai: 'text-embedding-3-small', google: 'gemini-embedding-001' };

export function createEmbedder(provider: EmbeddingProvider, model: string, apiKey: string): Embedder {
  if (provider === 'local') return new HashingEmbedder();
  return new RemoteEmbedder(provider, model || DEFAULT_EMBEDDING_MODELS[provider], apiKey);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * (b[i] ?? 0);
  return dot; // vectors are L2-normalised
}

function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return length ? vector.map(v => v / length) : vector;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
