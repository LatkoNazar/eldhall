import type pg from 'pg';

/**
 * Persistent vector index on PostgreSQL + pgvector (table support_knowledge_chunks, HNSW cosine).
 * Optional: migration 0006 creates the table only when the `vector` extension is available
 * (image pgvector/pgvector, see compose.knowledge.yaml). Without it the retriever keeps vectors in
 * memory, which is exact and fast for a few thousand passages.
 *
 * Rows are keyed by (knowledge_id, version, embedder, ord) and carry the content hash, so hosted
 * embeddings are computed once per published version and survive restarts; a new embedder id
 * (provider:model:dims) is a new index version, filled by /knowledge/reindex or lazily per turn.
 */
export interface StoredChunk { ord: number; section: string; body: string; contentHash: string; vector: number[] }

export interface VectorStore {
  readonly kind: 'pgvector';
  load(knowledgeId: string, version: number, embedder: string, contentHash: string): Promise<StoredChunk[] | null>;
  save(knowledgeId: string, businessId: string, version: number, embedder: string, contentHash: string, chunks: StoredChunk[]): Promise<void>;
  /** Nearest passages among the given published versions, cosine similarity in [−1, 1]. */
  nearest(refs: { id: string; version: number }[], embedder: string, query: number[], limit: number): Promise<{ knowledgeId: string; ord: number; similarity: number }[]>;
  stats(embedder: string): Promise<{ chunks: number; staleChunks: number }>;
  clear(embedder?: string): Promise<void>;
}

const literal = (vector: number[]) => `[${vector.map(v => (Number.isFinite(v) ? v : 0).toFixed(7)).join(',')}]`;

export class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector' as const;
  private readonly vector: string;
  private readonly distance: string;
  constructor(private readonly pool: pg.Pool, extensionSchema = 'public') {
    const schema = `"${extensionSchema.replaceAll('"', '""')}"`;
    this.vector = `${schema}.vector`;
    this.distance = `OPERATOR(${schema}.<=>)`;
  }

  /** Null when the table (and so the extension) is missing. */
  static async connect(pool: pg.Pool): Promise<PgVectorStore | null> {
    const { rows } = await pool.query<{ table: string | null; schema: string | null }>("SELECT to_regclass('support_knowledge_chunks')::text AS table, (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector') AS schema");
    return rows[0]?.table && rows[0].schema ? new PgVectorStore(pool, rows[0].schema) : null;
  }

  async load(knowledgeId: string, version: number, embedder: string, contentHash: string) {
    const { rows } = await this.pool.query<{ ord: number; section: string; body: string; content_hash: string; embedding: string }>(
      'SELECT ord, section, body, content_hash, embedding::text AS embedding FROM support_knowledge_chunks WHERE knowledge_id=$1 AND version=$2 AND embedder=$3 ORDER BY ord',
      [knowledgeId, version, embedder]);
    if (!rows.length || rows.some(row => row.content_hash !== contentHash)) return null;
    return rows.map(row => ({ ord: row.ord, section: row.section, body: row.body, contentHash: row.content_hash, vector: JSON.parse(row.embedding) as number[] }));
  }

  async save(knowledgeId: string, businessId: string, version: number, embedder: string, contentHash: string, chunks: StoredChunk[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM support_knowledge_chunks WHERE knowledge_id=$1 AND embedder=$2', [knowledgeId, embedder]);
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO support_knowledge_chunks(knowledge_id,business_id,version,embedder,ord,section,body,content_hash,embedding,tsv) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::${this.vector},to_tsvector('simple',$6||' '||$7))`,
          [knowledgeId, businessId, version, embedder, chunk.ord, chunk.section, chunk.body, contentHash, literal(chunk.vector)]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async nearest(refs: { id: string; version: number }[], embedder: string, query: number[], limit: number) {
    if (!refs.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL hnsw.ef_search = 200');
      const { rows } = await client.query<{ knowledge_id: string; ord: number; similarity: number }>(
        `SELECT c.knowledge_id, c.ord, 1 - (c.embedding ${this.distance} $1::${this.vector}) AS similarity
           FROM support_knowledge_chunks c
           JOIN unnest($2::uuid[], $3::int[]) AS r(id, version) ON r.id = c.knowledge_id AND r.version = c.version
          WHERE c.embedder = $4
          ORDER BY c.embedding ${this.distance} $1::${this.vector}
          LIMIT $5`,
        [literal(query), refs.map(r => r.id), refs.map(r => r.version), embedder, limit]);
      await client.query('COMMIT');
      return rows.map(row => ({ knowledgeId: row.knowledge_id, ord: row.ord, similarity: Number(row.similarity) }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async stats(embedder: string) {
    const { rows } = await this.pool.query<{ chunks: string; stale: string }>('SELECT count(*) FILTER (WHERE embedder=$1) AS chunks, count(*) FILTER (WHERE embedder<>$1) AS stale FROM support_knowledge_chunks', [embedder]);
    return { chunks: Number(rows[0]?.chunks ?? 0), staleChunks: Number(rows[0]?.stale ?? 0) };
  }

  async clear(embedder?: string) {
    if (embedder) await this.pool.query('DELETE FROM support_knowledge_chunks WHERE embedder<>$1', [embedder]);
    else await this.pool.query('DELETE FROM support_knowledge_chunks');
  }
}
