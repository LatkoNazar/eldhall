import { readFile } from 'node:fs/promises';
import type pg from 'pg';
export async function migrateSupport(pool:pg.Pool) {
  const sql=await readFile(new URL('../../../migrations/0002_support.sql',import.meta.url),'utf8');
  const turns=await readFile(new URL('../../../migrations/0003_support_turns.sql',import.meta.url),'utf8');
  const classification=await readFile(new URL('../../../migrations/0004_classification.sql',import.meta.url),'utf8');
  const insights=await readFile(new URL('../../../migrations/0005_insights.sql',import.meta.url),'utf8');
  const knowledge=await readFile(new URL('../../../migrations/0006_knowledge.sql',import.meta.url),'utf8');
  const externalKnowledge=await readFile(new URL('../../../migrations/0007_external_knowledge.sql',import.meta.url),'utf8');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('support-schema-v1'))");
    await client.query(sql);
    await client.query(turns);
    await client.query(classification);
    await client.query(insights);
    await client.query(knowledge);
    await client.query(externalKnowledge);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
