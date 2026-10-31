import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { loadEnvironment } from '../src/core/config.js';
import { migrateSupport } from '../src/modules/support/migrations.js';
import { PostgresSupportStore } from '../src/modules/support/postgres-store.js';
import { seedData } from '../src/modules/support/seed.js';
import { InsightsRepository } from '../src/modules/insights/repository.js';
import { InsightsService } from '../src/modules/insights/service.js';
import { insightsRoutes } from '../src/modules/insights/routes.js';
import type { InsightInput, InsightModel, InsightOutput, InsightRun } from '../src/modules/insights/contracts.js';

test('real PostgreSQL insights admission, worker recovery, evidence isolation, draft idempotency and revocation', { timeout: 60000 }, async t => {
  const env = { ...loadEnvironment(), ...process.env };
  const connection = { host: env.TEST_POSTGRES_HOST ?? env.POSTGRES_HOST ?? '127.0.0.1', port: Number(env.TEST_POSTGRES_PORT ?? env.POSTGRES_PORT ?? 5432),
    database: env.TEST_POSTGRES_DB ?? env.POSTGRES_DB ?? 'app', user: env.TEST_POSTGRES_USER ?? env.POSTGRES_USER ?? 'app', password: env.TEST_POSTGRES_PASSWORD ?? env.POSTGRES_PASSWORD ?? 'development-only', connectionTimeoutMillis: 3000 };
  const admin = new pg.Pool(connection);
  const schema = `insights_test_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool | undefined;
  const app = Fastify();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...connection, options: `-c search_path=${schema}`, max: 10 });
    await migrateSupport(pool); await migrateSupport(pool);
    const support = new PostgresSupportStore(pool);
    await support.seedIfEmpty(seedData());
    const [business, otherBusiness] = await support.businessesList(); assert.ok(business && otherBusiness);
    const customer = seedData().customers.find(item => item.businessId === business.id)!;
    const otherCustomer = seedData().customers.find(item => item.businessId === otherBusiness.id)!;
    const cases = await Promise.all([support.createCase(business.id, customer.id), support.createCase(business.id, customer.id)]);
    for (const c of cases) await support.addMessage(c.id, 'customer', 'Synthetic invoice download fails; contact fake@example.test.');
    const privateCase = await support.createCase(otherBusiness.id, otherCustomer.id);
    await support.addMessage(privateCase.id, 'customer', 'OTHER_BUSINESS_PRIVATE_MARKER');
    const source = await support.saveKnowledge({ id: randomUUID(), businessId: business.id, title: 'Billing documents', category: 'Billing', content: 'Ask a support agent to check a billing-document error. The cause must be verified.', version: 1, status: 'published', updatedAt: new Date().toISOString() });
    const revoked = await support.saveKnowledge({ ...source, id: randomUUID(), title: 'Old secret advice', content: 'REVOKED_KB_MARKER', status: 'revoked' });
    await pool.query("INSERT INTO support_messages(id,case_id,role,body,source_refs) VALUES($1,$2,'assistant','REVOKED_ASSISTANT_MARKER',$3)", [randomUUID(), cases[0]!.id, JSON.stringify([{ id: revoked.id, version: 1 }])]);
    await pool.query("INSERT INTO support_messages(id,case_id,role,body,external_source_refs) VALUES($1,$2,'assistant','EXTERNAL_UNVALIDATED_MARKER',$3)", [randomUUID(), cases[0]!.id, JSON.stringify([{ connectorId: 'company-kb', pointId: 42, contentHash: 'a'.repeat(64) }])]);
    const repository = new InsightsRepository(pool);
    let calls = 0;
    let analyze: (input: InsightInput) => Promise<InsightOutput> = async input => ({ findings: [{ kind: 'recurring_issue', title: 'Synthetic invoice-download reports', summary: 'Two sampled dialogues report an error. Cause remains unknown.', recommendation: 'Ask staff to reproduce the reported error.',
      evidence: input.tickets.map(ticket => ({ caseId: ticket.id, messageIds: [ticket.messages[0]!.id] })), knowledgeRefs: input.knowledge.map(kb => ({ id: kb.id, version: kb.version })), proposedArticle: { title: 'Invoice download troubleshooting — proposal', content: 'Draft for staff verification. Ask which error appears and check the service state; do not promise a confirmed resolution.' } }] });
    const model: InsightModel = { provider: 'synthetic-test', model: 'typed-fixture', analyze: async input => {
      calls++; assert.doesNotMatch(JSON.stringify(input), /OTHER_BUSINESS_PRIVATE_MARKER|REVOKED_KB_MARKER|REVOKED_ASSISTANT_MARKER|EXTERNAL_UNVALIDATED_MARKER|fake@example\.test|sessionToken|customerId/);
      assert.equal(input.sample.truncated, true);
      return analyze(input);
    } };
    const service = new InsightsService(repository, model, 10000);
    await app.register(insightsRoutes, { prefix: '/api/v1/insights', insights: service, operatorToken: 'synthetic-insights-operator' });
    await app.ready();
    const headers = { authorization: 'Bearer synthetic-insights-operator' };
    const post = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/insights/runs', headers, payload: body });
    let run: InsightRun;
    await t.test('HTTP accepts durably without model calls; rejects auth/identity mistakes and enforces request idempotency', async () => {
      assert.equal((await app.inject('/api/v1/insights/runs?businessId=' + business.id)).statusCode, 401);
      assert.equal((await post({ businessId: randomUUID() })).statusCode, 404);
      assert.equal((await post({ businessId: business.id, customerId: customer.id })).statusCode, 422);
      const requestId = randomUUID();
      const accepted = await post({ businessId: business.id, clientRequestId: requestId });
      assert.equal(accepted.statusCode, 202); run = accepted.json<InsightRun>(); assert.equal(run.status, 'queued'); assert.equal(calls, 0);
      assert.equal((await post({ businessId: business.id, clientRequestId: requestId })).json<InsightRun>().id, run.id);
      assert.equal((await post({ businessId: business.id, limit: 1, clientRequestId: requestId })).statusCode, 409);
      assert.equal((await post({ businessId: business.id, clientRequestId: randomUUID() })).statusCode, 409);
      assert.equal((await app.inject({ url: `/api/v1/insights/runs/${run.id}?businessId=${otherBusiness.id}`, headers })).statusCode, 404);
    });
    await t.test('worker completes persisted run from scoped visible input; concurrent draft creation inserts one unpublished document', async () => {
      assert.equal(await service.processOne('test-worker', new AbortController().signal), true);
      const done = await new InsightsRepository(pool!).get(business.id, run.id);
      assert.equal(done.status, 'completed'); assert.equal(done.findings[0]?.caseCount, 2);
      assert.equal(done.sample.caseCount, 2); assert.equal(done.sample.messageCount, 2); assert.equal(done.sample.knowledgeCount, 1); assert.equal(done.sample.truncated, true);
      assert.equal(calls, 1); assert.equal(await service.processOne('redelivery', new AbortController().signal), false);
      const finding = done.findings[0]!;
      const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'POST', url: `/api/v1/insights/runs/${run.id}/findings/${finding.id}/draft?businessId=${business.id}`, headers })));
      assert.equal(responses.every(response => response.statusCode === 200), true);
      const drafts = responses.map(response => response.json<{ draft: { id: string; status: string; content: string } }>().draft);
      assert.equal(new Set(drafts.map(draft => draft.id)).size, 1); assert.equal(drafts.every(draft => draft.status === 'draft'), true);
      assert.match(drafts[0]!.content, /AI DRAFT.*staff must verify/);
      assert.equal((await pool!.query("SELECT count(*)::int n FROM support_knowledge WHERE category='AI draft'")).rows[0]?.n, 1);
      assert.equal((await pool!.query('SELECT count(*)::int n FROM support_refunds')).rows[0]?.n, 0);
    });
    await t.test('model failure records owned error and no findings; empty business avoids a model call', async () => {
      const failure = await service.create(business.id, 25);
      analyze = async () => { throw new Error('vendor-secret-SHOULD_NOT_ESCAPE'); };
      await service.processOne('failure-worker', new AbortController().signal);
      const failed = await repository.get(business.id, failure.id); assert.equal(failed.status, 'failed'); assert.deepEqual(failed.findings, []); assert.doesNotMatch(failed.error ?? '', /vendor-secret/);
      const emptyBusiness = await support.createBusiness({ id: randomUUID(), slug: 'empty-insights-test', name: 'Synthetic Empty Business', currency: 'UAH', policy: business.policy });
      const empty = await service.create(emptyBusiness.id, 25); const before = calls;
      await service.processOne('empty-worker', new AbortController().signal);
      assert.equal(calls, before); const done = await repository.get(emptyBusiness.id, empty.id); assert.equal(done.status, 'completed'); assert.equal(done.sample.caseCount, 0); assert.deepEqual(done.findings, []);
    });
    await t.test('expired leases recover across repository restart and reject stale completion; retry cap terminates abandoned runs', async () => {
      analyze = async () => ({ findings: [] });
      const accepted = await service.create(business.id, 25);
      const dead = await repository.claim('dead-worker'); assert.ok(dead);
      const oldInput = await repository.snapshot(dead);
      await pool!.query("UPDATE support_insight_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [accepted.id]);
      const recovered = new InsightsService(new InsightsRepository(pool!), model, 10000);
      await recovered.processOne('replacement-worker', new AbortController().signal);
      assert.equal((await repository.get(business.id, accepted.id)).status, 'completed');
      await assert.rejects(repository.complete(dead, oldInput, []), /lease changed/);
      const capped = await service.create(business.id, 25);
      await pool!.query("UPDATE support_insight_runs SET status='running',attempts=3,lease_expires_at=now()-interval '1 second' WHERE id=$1", [capped.id]);
      assert.equal(await repository.claim('cap-worker'), null); assert.equal((await repository.get(business.id, capped.id)).status, 'failed');
    });
    await t.test('graceful worker cancellation requeues the read-only run and a replacement completes it', async () => {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const stoppable: InsightModel = { provider: 'synthetic-test', model: 'abort-fixture', analyze: async (_input, _context, signal) => new Promise((_resolve, reject) => {
        entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }) };
      const stopping = new InsightsService(repository, stoppable, 10000);
      const accepted = await stopping.create(business.id, 25);
      const controller = new AbortController();
      const processing = stopping.processOne('stopping-worker', controller.signal);
      await started; controller.abort(new Error('Synthetic worker restart')); await processing;
      assert.equal((await repository.get(business.id, accepted.id)).status, 'queued');
      await service.processOne('replacement-after-stop', new AbortController().signal);
      const recovered = await repository.get(business.id, accepted.id);
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.model, 'typed-fixture');
    });
    await t.test('snapshot counts and samples remain consistent across a concurrent ticket/message/KB commit', async () => {
      const raceBusiness = await support.createBusiness({ id: randomUUID(), slug: 'snapshot-race-test', name: 'Synthetic Snapshot Race', currency: 'UAH', policy: business.policy });
      const raceCustomer = await support.createCustomer({ id: randomUUID(), businessId: raceBusiness.id, name: 'Synthetic Snapshot Customer', email: 'snapshot@example.test', plan: 'Test', sessionToken: randomUUID() });
      const firstCase = await support.createCase(raceBusiness.id, raceCustomer.id);
      await support.addMessage(firstCase.id, 'customer', 'First synthetic problem report.');
      await support.saveKnowledge({ ...source, id: randomUUID(), businessId: raceBusiness.id, title: 'First published guidance' });
      const accepted = await service.create(raceBusiness.id, 25);
      const lease = await repository.claim('snapshot-race-worker'); assert.equal(lease?.id, accepted.id); assert.ok(lease);
      let committedBetweenReads = false;
      const interleavingPool = new Proxy(pool!, { get(target, key) {
        if (key !== 'connect') return Reflect.get(target, key, target);
        return async () => {
          const client = await target.connect();
          return new Proxy(client, { get(connection, property) {
            if (property === 'release') return connection.release.bind(connection);
            if (property !== 'query') return Reflect.get(connection, property, connection);
            return async (sql: string, values?: unknown[]) => {
              const result = await connection.query(sql, values);
              if (!committedBetweenReads && sql.startsWith('SELECT (SELECT count(*)::int FROM support_cases')) {
                committedBetweenReads = true;
                const secondCase = await support.createCase(raceBusiness.id, raceCustomer.id);
                await support.addMessage(secondCase.id, 'customer', 'Second concurrent synthetic report.');
                await support.saveKnowledge({ ...source, id: randomUUID(), businessId: raceBusiness.id, title: 'Concurrently published guidance' });
              }
              return result;
            };
          } });
        };
      } });
      const snapshot = await new InsightsRepository(interleavingPool).snapshot(lease);
      assert.equal(committedBetweenReads, true);
      assert.equal(snapshot.sample.totalCases, 1); assert.equal(snapshot.sample.caseCount, 1);
      assert.equal(snapshot.sample.totalPublishedKnowledge, 1); assert.equal(snapshot.sample.knowledgeCount, 1);
      assert.equal((await pool!.query('SELECT count(*)::int n FROM support_cases WHERE business_id=$1', [raceBusiness.id])).rows[0]?.n, 2);
      assert.equal((await pool!.query("SELECT count(*)::int n FROM support_knowledge WHERE business_id=$1 AND status='published'", [raceBusiness.id])).rows[0]?.n, 2);
      await repository.complete(lease, snapshot, []);
    });
    await t.test('revocation fences in-flight completion and hides earlier derived findings and draft actions', async () => {
      let entered!: () => void; let release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      analyze = async () => { entered(); await gate; return { findings: [] }; };
      const accepted = await service.create(business.id, 25);
      const processing = service.processOne('revoked-worker', new AbortController().signal);
      await ready;
      await support.saveKnowledge({ ...source, version: 2, status: 'revoked' }, 1);
      release(); await processing;
      assert.equal((await repository.get(business.id, accepted.id)).status, 'failed');
      const earlier = await repository.get(business.id, run.id);
      assert.equal(earlier.stale, true); assert.deepEqual(earlier.findings, []);
      const raw = (await pool!.query('SELECT data FROM support_insight_runs WHERE id=$1', [run.id])).rows[0]!.data as InsightRun;
      const findingId = raw.findings[0]!.id;
      assert.equal((await app.inject({ method: 'POST', url: `/api/v1/insights/runs/${run.id}/findings/${findingId}/draft?businessId=${business.id}`, headers })).statusCode, 409);
      assert.equal((await app.inject({ url: '/api/v1/insights/runs?businessId=' + otherBusiness.id, headers })).json<{ runs: InsightRun[] }>().runs.length, 0);
    });
  } finally {
    await app.close();
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
