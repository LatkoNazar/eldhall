import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { KnowledgeSource } from '../support/contracts.js';
import { emptySample, InsightError, type InsightFinding, type InsightInput, type InsightLease, type InsightRun } from './contracts.js';

interface Row { id: string; business_id: string; status: InsightRun['status']; data: Omit<InsightRun, 'id' | 'businessId' | 'status' | 'createdAt'>; input_snapshot: InsightInput | null; requested_limit: number; fence: number; created_at: Date }
const runFrom = (row: Row): InsightRun => ({ ...row.data, id: row.id, businessId: row.business_id, status: row.status, createdAt: row.created_at.toISOString() });
const clean = (value: string) => value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').replace(/\b(?:sk-(?:or-v1-|proj-)?)[A-Za-z0-9_-]{20,}\b/g, '[credential]').slice(0, 600);

export class InsightsRepository {
  constructor(readonly pool: pg.Pool) {}
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async assertSchema() { await this.pool.query('SELECT input_snapshot,fence FROM support_insight_runs LIMIT 0'); }
  async create(businessId: string, limit: number, requestId: string | undefined, provider: string, model: string): Promise<InsightRun> {
    return this.transaction(async client => {
      if (!(await client.query('SELECT id FROM support_businesses WHERE id=$1 FOR UPDATE', [businessId])).rowCount) throw new InsightError(404, 'Business not found');
      if (requestId) {
        const old = (await client.query<Row>('SELECT * FROM support_insight_runs WHERE business_id=$1 AND request_id=$2', [businessId, requestId])).rows[0];
        if (old) { if (old.requested_limit !== limit) throw new InsightError(409, 'Request id already used with different input'); return this.visible(old, client); }
      }
      if ((await client.query("SELECT id FROM support_insight_runs WHERE business_id=$1 AND status IN ('queued','running')", [businessId])).rowCount) throw new InsightError(409, 'This business already has an active analysis');
      const data = { completedAt: null, provider, model, sample: emptySample(), findings: [], error: null, stale: false };
      const row = (await client.query<Row>("INSERT INTO support_insight_runs(id,business_id,request_id,requested_limit,status,data) VALUES($1,$2,$3,$4,'queued',$5) RETURNING *", [randomUUID(), businessId, requestId ?? null, limit, JSON.stringify(data)])).rows[0]!;
      return runFrom(row);
    });
  }
  async list(businessId: string): Promise<InsightRun[]> {
    const rows = (await this.pool.query<Row>('SELECT * FROM support_insight_runs WHERE business_id=$1 ORDER BY created_at DESC,id LIMIT 30', [businessId])).rows;
    return Promise.all(rows.map(row => this.visible(row, this.pool)));
  }
  async get(businessId: string, id: string): Promise<InsightRun> {
    const row = (await this.pool.query<Row>('SELECT * FROM support_insight_runs WHERE business_id=$1 AND id=$2', [businessId, id])).rows[0];
    if (!row) throw new InsightError(404, 'Analysis not found');
    return this.visible(row, this.pool);
  }
  private async visible(row: Row, query: pg.Pool | pg.PoolClient): Promise<InsightRun> {
    const run = runFrom(row);
    if (row.input_snapshot && !await this.refsCurrent(query, row.business_id, row.input_snapshot.sourceRefs)) return { ...run, stale: true, findings: [], error: 'Knowledge sources changed. Run a new analysis to view current findings.' };
    return run;
  }
  async claim(owner: string): Promise<InsightLease | null> {
    return this.transaction(async client => {
      await client.query("UPDATE support_insight_runs SET status='failed',data=jsonb_set(jsonb_set(data,'{error}',to_jsonb('Analysis recovery limit reached'::text)),'{completedAt}',to_jsonb(now())),lease_owner=NULL,lease_expires_at=NULL WHERE attempts>=3 AND (status='queued' OR (status='running' AND lease_expires_at<now()))");
      const row = (await client.query<Row>("SELECT * FROM support_insight_runs WHERE (status='queued' AND attempts<3) OR (status='running' AND lease_expires_at<now() AND attempts<3) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!row) return null;
      const updated = (await client.query<Row>("UPDATE support_insight_runs SET status='running',lease_owner=$2,lease_expires_at=now()+interval '30 seconds',fence=fence+1,attempts=attempts+1,updated_at=now() WHERE id=$1 RETURNING *", [row.id, owner])).rows[0]!;
      return { id: row.id, businessId: row.business_id, owner, fence: updated.fence, limit: row.requested_limit };
    });
  }
  async active(lease: InsightLease): Promise<boolean> {
    return !!(await this.pool.query("SELECT id FROM support_insight_runs WHERE id=$1 AND business_id=$2 AND status='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>now()", [lease.id, lease.businessId, lease.owner, lease.fence])).rowCount;
  }
  async renew(lease: InsightLease): Promise<boolean> {
    return !!(await this.pool.query("UPDATE support_insight_runs SET lease_expires_at=now()+interval '30 seconds',updated_at=now() WHERE id=$1 AND business_id=$2 AND status='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>now()", [lease.id, lease.businessId, lease.owner, lease.fence])).rowCount;
  }
  async snapshot(lease: InsightLease, model?: { provider: string; model: string }): Promise<InsightInput> {
    return this.transaction(async client => {
      // Counts, message selection and KB excerpts must share one committed view.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const known = (await client.query<Row>("SELECT * FROM support_insight_runs WHERE id=$1 AND business_id=$2 AND status='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>now() FOR UPDATE", [lease.id, lease.businessId, lease.owner, lease.fence])).rows[0];
      if (!known) throw new InsightError(409, 'Analysis lease changed');
      // One repeatable input per claimed attempt; raw input is never returned by the API.
      const counts = (await client.query<{ cases: number; knowledge: number }>("SELECT (SELECT count(*)::int FROM support_cases c WHERE c.business_id=$1 AND EXISTS(SELECT 1 FROM support_messages m WHERE m.case_id=c.id)) cases,(SELECT count(*)::int FROM support_knowledge WHERE business_id=$1 AND status='published') knowledge", [lease.businessId])).rows[0]!;
      const sources = (await client.query<{ id: string; title: string; version: number; content: string; full_length: number }>("SELECT id,title,version,left(content,1200) content,length(content) full_length FROM support_knowledge WHERE business_id=$1 AND status='published' ORDER BY updated_at DESC,id LIMIT 20", [lease.businessId])).rows;
      const cases = (await client.query<{ id: string; updated_at: Date }>('SELECT c.id,c.updated_at FROM support_cases c WHERE c.business_id=$1 AND EXISTS(SELECT 1 FROM support_messages m WHERE m.case_id=c.id) ORDER BY c.updated_at DESC,c.id LIMIT $2', [lease.businessId, lease.limit])).rows;
      const input: InsightInput = { tickets: [], knowledge: sources.map(({ id, title, version, content }) => ({ id, title, version, content })), sourceRefs: sources.map(({ id, version }) => ({ id, version })), sample: { ...emptySample(), totalCases: counts.cases, totalPublishedKnowledge: counts.knowledge, truncated: counts.cases > cases.length || counts.knowledge > sources.length || sources.some(source => source.full_length > 1200) } };
      const refs = new Map(input.sourceRefs.map(ref => [ref.id, ref.version]));
      for (const c of cases) {
        const messages = (await client.query<{ id: string; role: string; body: string; created_at: Date; source_refs: { id: string; version: number }[]; external_source_refs: unknown[] }>('SELECT id,role,body,source_refs,external_source_refs,created_at FROM support_messages WHERE case_id=$1 ORDER BY created_at DESC,id DESC LIMIT 9', [c.id])).rows;
        if (messages.length > 8) input.sample.truncated = true;
        const visible = [];
        for (const message of messages.slice(0, 8).reverse()) {
          // Insights does not claim to validate or enumerate a remote company's corpus.
          if (message.external_source_refs.length) { input.sample.truncated = true; continue; }
          if (!await this.refsCurrent(client, lease.businessId, message.source_refs)) { input.sample.truncated = true; continue; }
          const item = { id: message.id, role: message.role, body: clean(message.body) };
          if (message.body.length > 600) input.sample.truncated = true;
          visible.push(item);
          for (const ref of message.source_refs) refs.set(ref.id, ref.version);
        }
        if (!visible.length) continue;
        const ticket = { id: c.id, messages: visible };
        if (JSON.stringify({ ...input, tickets: [...input.tickets, ticket] }).length > 45_000) { input.sample.truncated = true; break; }
        input.tickets.push(ticket);
        for (const message of visible) {
          const timestamp = messages.find(item => item.id === message.id)!.created_at.toISOString();
          if (input.sample.from === null || timestamp < input.sample.from) input.sample.from = timestamp;
          if (input.sample.to === null || timestamp > input.sample.to) input.sample.to = timestamp;
        }
      }
      input.sourceRefs = [...refs].map(([id, version]) => ({ id, version }));
      input.sample.caseCount = input.tickets.length;
      input.sample.messageCount = input.tickets.reduce((total, ticket) => total + ticket.messages.length, 0);
      input.sample.knowledgeCount = sources.length;
      await client.query('UPDATE support_insight_runs SET input_snapshot=$2,data=$3,updated_at=now() WHERE id=$1', [lease.id, JSON.stringify(input), JSON.stringify({ ...known.data, ...model, sample: input.sample })]);
      return input;
    });
  }
  async complete(lease: InsightLease, input: InsightInput, findings: InsightFinding[]): Promise<void> {
    await this.transaction(async client => {
      const row = (await client.query<Row>("SELECT * FROM support_insight_runs WHERE id=$1 AND business_id=$2 AND status='running' AND lease_owner=$3 AND fence=$4 AND lease_expires_at>now() FOR UPDATE", [lease.id, lease.businessId, lease.owner, lease.fence])).rows[0];
      if (!row) throw new InsightError(409, 'Analysis lease changed');
      if (!await this.refsCurrent(client, lease.businessId, input.sourceRefs, true)) throw new InsightError(409, 'Published knowledge changed during analysis');
      await client.query("UPDATE support_insight_runs SET status='completed',data=$2,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1", [lease.id, JSON.stringify({ ...row.data, sample: input.sample, findings, error: null, completedAt: new Date().toISOString() })]);
    });
  }
  async fail(lease: InsightLease): Promise<void> {
    await this.pool.query("UPDATE support_insight_runs SET status='failed',data=jsonb_set(jsonb_set(data,'{error}',to_jsonb('Analysis failed or its source context changed. No findings were published; retry with a new analysis.'::text)),'{completedAt}',to_jsonb(now())),lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND business_id=$2 AND status='running' AND lease_owner=$3 AND fence=$4", [lease.id, lease.businessId, lease.owner, lease.fence]);
  }
  async requeue(lease: InsightLease): Promise<void> {
    await this.pool.query("UPDATE support_insight_runs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1 AND business_id=$2 AND status='running' AND lease_owner=$3 AND fence=$4", [lease.id, lease.businessId, lease.owner, lease.fence]);
  }
  async refsCurrent(query: pg.Pool | pg.PoolClient, businessId: string, refs: { id: string; version: number }[], lock = false): Promise<boolean> {
    if (!refs.length) return true;
    const rows = (await query.query<{ id: string; version: number }>("SELECT id,version FROM support_knowledge WHERE business_id=$1 AND status='published' AND id=ANY($2::uuid[])" + (lock ? ' FOR SHARE' : ''), [businessId, refs.map(ref => ref.id)])).rows;
    return refs.every(ref => rows.some(row => row.id === ref.id && row.version === ref.version));
  }
  async draft(businessId: string, runId: string, findingId: string): Promise<KnowledgeSource> {
    return this.transaction(async client => {
      const row = (await client.query<Row>('SELECT * FROM support_insight_runs WHERE id=$1 AND business_id=$2 FOR UPDATE', [runId, businessId])).rows[0];
      if (!row) throw new InsightError(404, 'Analysis not found');
      if (row.status !== 'completed' || !row.input_snapshot || !await this.refsCurrent(client, businessId, row.input_snapshot.sourceRefs, true)) throw new InsightError(409, 'Analysis sources are no longer current');
      const finding = row.data.findings.find(item => item.id === findingId);
      if (!finding) throw new InsightError(404, 'Finding not found');
      if (!finding.proposedArticle) throw new InsightError(409, 'This finding has no proposed article');
      if (!finding.draftId) {
        finding.draftId = randomUUID();
        const provenance = `AI DRAFT — staff must verify before publishing.\nAnalysis: ${runId}; finding: ${findingId}.\nEvidence tickets: ${finding.evidence.map(item => item.caseId).join(', ')}.\nKnowledge source versions: ${finding.knowledgeRefs.map(ref => `${ref.id}@${ref.version}`).join(', ') || 'none cited'}.\n\n`;
        await client.query("INSERT INTO support_knowledge(id,business_id,title,category,content,version,status,updated_at) VALUES($1,$2,$3,'AI draft',$4,1,'draft',now())", [finding.draftId, businessId, finding.proposedArticle.title, provenance + finding.proposedArticle.content]);
        await client.query('UPDATE support_insight_runs SET data=$2,updated_at=now() WHERE id=$1', [runId, JSON.stringify(row.data)]);
      }
      const draft = (await client.query('SELECT * FROM support_knowledge WHERE id=$1 AND business_id=$2', [finding.draftId, businessId])).rows[0];
      if (!draft) throw new InsightError(409, 'The draft is no longer available');
      return { id: draft.id as string, businessId, title: draft.title as string, category: draft.category as string, content: draft.content as string, version: draft.version as number, status: draft.status as KnowledgeSource['status'], updatedAt: (draft.updated_at as Date).toISOString() };
    });
  }
}
