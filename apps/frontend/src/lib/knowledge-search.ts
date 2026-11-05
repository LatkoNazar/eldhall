// Viewer contracts for the local retriever and external knowledge adapter.
export interface KnowledgePassage { section: string; text: string; score: number; lexicalRank: number | null; vectorRank: number | null; similarity: number | null }
export interface KnowledgeHit { id: string; title: string; version: number; category?: string; audience?: 'customer' | 'internal'; sourceUrl?: string | null; content: string; section: string; score: number; passages: KnowledgePassage[] }
export interface KnowledgeIndex { embedder: { id: string }; vectorStore: string; chunks: number | null; staleChunks: number | null; published: number | null; urlImport: boolean; readOnly?: boolean; collection?: string }
export interface KnowledgeSearchResult { query: string; mode: string; embedder: string; tookMs: number; hits: KnowledgeHit[] }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const nullableNumber = (value: unknown) => value === null || finite(value)
const optionalString = (value: unknown) => value === undefined || typeof value === 'string'

export function isKnowledgeIndex(value: unknown): value is KnowledgeIndex {
  return record(value)
    && record(value.embedder) && typeof value.embedder.id === 'string'
    && typeof value.vectorStore === 'string'
    && nullableNumber(value.chunks) && nullableNumber(value.staleChunks) && nullableNumber(value.published)
    && typeof value.urlImport === 'boolean'
    && (value.readOnly === undefined || typeof value.readOnly === 'boolean')
    && optionalString(value.collection)
}

function passage(value: unknown): value is KnowledgePassage {
  return record(value)
    && typeof value.section === 'string' && typeof value.text === 'string'
    && finite(value.score)
    && nullableNumber(value.lexicalRank) && nullableNumber(value.vectorRank) && nullableNumber(value.similarity)
}

function hit(value: unknown): value is KnowledgeHit {
  return record(value)
    && typeof value.id === 'string' && typeof value.title === 'string'
    && finite(value.version)
    && optionalString(value.category)
    && (value.audience === undefined || value.audience === 'customer' || value.audience === 'internal')
    && (value.sourceUrl === null || optionalString(value.sourceUrl))
    && typeof value.content === 'string' && typeof value.section === 'string' && finite(value.score)
    && Array.isArray(value.passages) && value.passages.every(passage)
}

// Keep unknown metadata compatible; validate the nested values before the UI
// calls map/slice/toFixed or renders them as React children.
export function isKnowledgeSearchResult(value: unknown): value is KnowledgeSearchResult {
  return record(value)
    && typeof value.query === 'string' && typeof value.mode === 'string' && typeof value.embedder === 'string'
    && finite(value.tookMs)
    && Array.isArray(value.hits) && value.hits.every(hit)
}
