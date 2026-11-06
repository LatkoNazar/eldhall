import { hasUnrepresentedInput, isAcknowledgement } from './text.js';
import type pg from 'pg';
import type { RequestCatalog, RequestEvent } from './contracts.js';
import { emptyCatalog } from './engine.js';

type Queryable = Pick<pg.PoolClient, 'query'>;
/** Caller holds the support case row lock for every mutation. */
export async function readRequestCatalog(client: Queryable, caseId: string, history = false): Promise<RequestCatalog> {
  const row = (await client.query('SELECT * FROM support_request_catalogs WHERE case_id=$1', [caseId])).rows[0];
  const catalog: RequestCatalog = row ? { version: row.version, syncState: row.sync_state, lastSourceMessageId: row.last_source_message_id, requests: row.document, history: { events: [], hasMore: false } } : emptyCatalog();
  const messages=(await client.query("SELECT id,body FROM support_messages WHERE case_id=$1 AND role='customer'",[caseId])).rows;
  if(hasUnrepresentedInput(catalog.requests,messages)) catalog.syncState='needs_review';
  if (history) {
    const rows = (await client.query('SELECT event FROM support_request_events WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101', [caseId])).rows;
    catalog.history = { events: rows.slice(0, 100).reverse().map(row => row.event as RequestEvent), hasMore: rows.length > 100 };
  }
  return catalog;
}
export async function saveRequestCatalog(client: Queryable, caseId: string, catalog: RequestCatalog) {
  await client.query('INSERT INTO support_request_catalogs(case_id,version,sync_state,last_source_message_id,document) VALUES($1,$2,$3,$4,$5) ON CONFLICT(case_id) DO UPDATE SET version=excluded.version,sync_state=excluded.sync_state,last_source_message_id=excluded.last_source_message_id,document=excluded.document', [caseId, catalog.version, catalog.syncState, catalog.lastSourceMessageId, JSON.stringify(catalog.requests)]);
  for (const event of catalog.history.events) await client.query('INSERT INTO support_request_events(id,case_id,request_id,revision,event,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING', [event.id, caseId, event.requestId, event.revision, JSON.stringify(event), event.at]);
}

export async function reopenTrackedCaseForMessage(client: Queryable, caseId: string, body: string) {
  if(isAcknowledgement(body)) return;
  await client.query("UPDATE support_cases SET status=CASE WHEN ownership='staff' THEN 'escalated' ELSE 'open' END,updated_at=now() WHERE id=$1 AND status='resolved' AND EXISTS(SELECT 1 FROM support_request_catalogs WHERE case_id=$1 AND document<>'[]'::jsonb)",[caseId]);
}
