import { terms } from './text.js';

export interface Embedder {
  /** provider:model:dimensions — vectors are only comparable within one id. */
  readonly id: string;
  readonly dimensions: number;
  /** Cosine similarity below which a vector-only match is treated as noise. Model specific. */
  readonly minSimilarity: number;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
}

/**
 * Deterministic local embedder: signed feature hashing of search terms (weight 1) and character
 * trigrams of each term (weight 0.35), L2-normalised. No network, no key and no vector database,
 * so it satisfies the MVP rule "no new infra" while still giving a semantic-ish second signal.
 * Cross-lingual recall comes from the synonym canonicalisation in terms(); trigrams absorb
 * inflections the stemmer misses. A hosted embedding model can replace it behind the same interface.
 */
export class HashingEmbedder implements Embedder {
  readonly dimensions: number;
  readonly id: string;
  readonly minSimilarity = 0.22;

  constructor(dimensions = 768) {
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
