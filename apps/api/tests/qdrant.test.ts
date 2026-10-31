import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createExternalKnowledge, qdrantKnowledgeSchema, type QdrantKnowledgeConfig } from '../src/modules/knowledge/qdrant.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const businessId = '00000000-0000-4000-8000-000000000001';
const scope = { businessId, plan: 'pro' };
const point = () => ({ id: '00000000-0000-4000-8000-000000000011', payload: { metadata: { text: 'Verified company policy.', title: 'Help', version: 2, tenant: 'company-a', state: 'published', audience: 'customer', plans: ['pro'] } } });
function config(url: string): QdrantKnowledgeConfig {
  return qdrantKnowledgeSchema.parse({ id: 'company-kb', businessId, type: 'qdrant', url, collection: 'central-help', credentialEnv: 'QDRANT_KEY', vectorName: 'help-vectors', allowInsecureLoopback: true,
    embedding: { provider: 'local', model: 'company-existing-embedder', dimensions: 3, baseUrl: `${url}/v1`, credentialEnv: 'EMBEDDING_KEY' },
    fields: { text: 'metadata.text', title: 'metadata.title', version: 'metadata.version' },
    access: { tenant: { field: 'metadata.tenant', value: 'company-a' }, published: { field: 'metadata.state', value: 'published' }, customerVisible: { field: 'metadata.audience', value: 'customer' }, planField: 'metadata.plans' },
  });
}
async function fixture() {
  const requests: { method: string; path: string; body: Record<string, unknown>; key?: string; authorization?: string }[] = [];
  const state = { points: [point()], vectorSize: 3, embedding: [0.1, 0.2, 0.3], fail: false, redirect: '', hold: false, oversized: false };
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    requests.push({ method: request.method!, path: request.url!, body, key: request.headers['api-key'] as string, authorization: request.headers.authorization });
    if (state.hold) return;
    if (state.redirect) { response.writeHead(302, { location: state.redirect }); response.end(); return; }
    response.setHeader('Content-Type', 'application/json');
    if (state.fail) { response.writeHead(503); response.end('private-provider-diagnostic'); return; }
    if (state.oversized) { response.end('x'.repeat(513 * 1024)); return; }
    const payload = request.url === '/collections/central-help' ? { result: { config: { params: { vectors: { 'help-vectors': { size: state.vectorSize, distance: 'Cosine' } } } } } }
      : request.url === '/v1/embeddings' ? { data: [{ index: 0, embedding: state.embedding }] }
        : request.url === '/collections/central-help/points/query' ? { result: { points: state.points } }
          : request.url === '/collections/central-help/points' ? { result: state.points.filter(p => (body.ids as unknown[]).includes(p.id)) } : null;
    if (!payload) response.writeHead(404);
    response.end(JSON.stringify(payload));
  })().catch(() => { response.writeHead(500); response.end(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  return { url, requests, state, stop: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const env = { QDRANT_KEY: 'synthetic-qdrant-key', EMBEDDING_KEY: 'synthetic-embedding-key' };

test('existing Qdrant is queried read-only with named vector, exact embedding dimensions and trusted payload scope', async () => {
  const f = await fixture();
  try {
    const external = createExternalKnowledge([config(f.url)], env);
    const result = await external.search(scope, 'How does this policy work?');
    assert.equal(result.hits[0]?.content, 'Verified company policy.');
    assert.equal(result.hits[0]?.version, 2);
    assert.equal(result.refs[0]?.connectorId, 'company-kb');
    assert.equal(external.hasBusiness('unconfigured'), false);
    assert.deepEqual(await external.search({ ...scope, businessId: 'other' }, 'Question'), { hits: [], refs: [] });
    assert.equal(await external.validate(scope, result.refs), true);
    assert.deepEqual(f.requests.map(r => [r.method, r.path]), [['GET', '/collections/central-help'], ['POST', '/v1/embeddings'], ['POST', '/collections/central-help/points/query'], ['POST', '/collections/central-help/points']]);
    assert.deepEqual(f.requests[1]?.body, { model: 'company-existing-embedder', input: ['How does this policy work?'], dimensions: 3 });
    assert.equal(f.requests[1]?.authorization, 'Bearer synthetic-embedding-key');
    assert.equal(f.requests[2]?.key, 'synthetic-qdrant-key');
    assert.equal(f.requests[2]?.body.using, 'help-vectors');
    assert.equal(f.requests[2]?.body.with_vector, false);
    assert.deepEqual((f.requests[2]?.body.filter as { must: unknown[] }).must, [{ key: 'metadata.tenant', match: { value: 'company-a' } }, { key: 'metadata.state', match: { value: 'published' } }, { key: 'metadata.audience', match: { value: 'customer' } }, { key: 'metadata.plans', match: { any: ['pro'] } }]);
    assert.ok(!JSON.stringify(external.describe(businessId)).includes(f.url));
  } finally { await f.stop(); }
});

test('Qdrant responses are independently scoped, and changed/deleted/revoked sources fail provenance validation', async () => {
  const f = await fixture();
  try {
    const external = createExternalKnowledge([config(f.url)], env);
    const found = await external.search(scope, 'policy');
    const variants = [{ tenant: 'other-company' }, { audience: 'internal' }, { state: 'draft' }, { plans: ['enterprise'] }, { text: 'Modified policy' }];
    for (const variant of variants) {
      f.state.points = [{ ...point(), payload: { metadata: { ...point().payload.metadata, ...variant } } }];
      assert.equal(await external.validate(scope, found.refs), false);
      if (!('text' in variant)) assert.deepEqual((await external.search(scope, 'policy')).hits, []);
    }
    f.state.points = [];
    assert.equal(await external.validate(scope, found.refs), false);
    assert.equal(await external.validate({ ...scope, businessId: 'other' }, found.refs), false);
    assert.equal(await external.validate(scope, [{ ...found.refs[0]!, connectorId: 'removed' }]), false);
  } finally { await f.stop(); }
});

test('collection/embedding mismatch fails before passing facts and never writes the existing collection', async () => {
  const f = await fixture();
  try {
    const external = createExternalKnowledge([config(f.url)], env);
    f.state.vectorSize = 768;
    await assert.rejects(external.search(scope, 'policy'), /vector configuration/);
    assert.equal(f.requests.length, 1);
    f.state.vectorSize = 3;
    f.state.embedding = [1, 2];
    await assert.rejects(external.search(scope, 'policy'), /Embedding response/);
    assert.equal(f.requests.some(r => r.path.endsWith('/points/query')), false);
  } finally { await f.stop(); }
});

test('external config requires deliberate scope, safe endpoints, environment secrets and distinct businesses', async () => {
  const good = config('http://127.0.0.1:6333');
  for (const patch of [{ access: {} }, { access: { singleTenant: true } }, { url: 'http://company-db.test' }, { url: 'https://user:secret@company.test' }, { fields: { text: '__proto__.text' } }, { credentialEnv: 'actual-inline-secret' }, { embedding: { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 } }]) assert.equal(qdrantKnowledgeSchema.safeParse({ ...good, ...patch }).success, false);
  assert.equal(qdrantKnowledgeSchema.safeParse({ ...good, access: { singleTenant: true, trustedPublicCollection: true } }).success, true);
  assert.throws(() => createExternalKnowledge([good], {}), /not configured/);
  assert.equal(supportConfigSchema.safeParse({ externalKnowledge: [good, { ...good, id: 'second' }] }).success, false);
  const store = new MemorySupportStore();
  await assert.rejects(bootstrapSupportConfig(store, supportConfigSchema.parse({ externalKnowledge: [good] })), /unknown business/);
  assert.deepEqual(await store.businessesList(), []);
});

test('redirects never forward keys, errors are redacted, response size is bounded and validation fails closed', async () => {
  const f = await fixture(), target = await fixture();
  try {
    const external = createExternalKnowledge([config(f.url)], env);
    const refs = (await external.search(scope, 'policy')).refs;
    f.state.redirect = target.url;
    await assert.rejects(external.search(scope, 'policy'), /External knowledge request failed/);
    assert.equal(target.requests.length, 0);
    f.state.redirect = '';
    f.state.fail = true;
    await assert.rejects(external.search(scope, 'policy'), error => error instanceof Error && !/private-provider|synthetic-|127\.0\.0\.1/.test(error.message));
    assert.equal(await external.validate(scope, refs), false);
    f.state.fail = false; f.state.oversized = true;
    await assert.rejects(external.search(scope, 'policy'), /External knowledge request failed/);
  } finally { await f.stop(); await target.stop(); }
});

test('whole external search deadline and caller cancellation bound real HTTP requests', async () => {
  const f = await fixture();
  try {
    f.state.hold = true;
    const external = createExternalKnowledge([{ ...config(f.url), timeoutMs: 100 }], env);
    await assert.rejects(external.search(scope, 'policy'), /deadline/);
    const controller = new AbortController();
    const pending = createExternalKnowledge([config(f.url)], env).search(scope, 'policy', controller.signal);
    controller.abort();
    await assert.rejects(pending, /deadline/);
  } finally { await f.stop(); }
});

test('hosted query embedding uses the explicitly configured model and dimensions with unnamed collections', async () => {
  for (const provider of ['openai', 'google'] as const) {
    const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const settings = qdrantKnowledgeSchema.parse({ ...config('https://qdrant.example.test'), vectorName: undefined, embedding: { provider, model: provider === 'openai' ? 'text-embedding-3-small' : 'gemini-embedding-001', dimensions: 3, credentialEnv: 'EMBEDDING_KEY' } });
    const mockFetch = (async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url: String(url), body, headers: new Headers(init?.headers) });
      const result = String(url).includes('api.openai.com') ? { data: [{ index: 0, embedding: [1, 0, 0] }] }
        : String(url).includes('generativelanguage.googleapis.com') ? { embedding: { values: [1, 0, 0] } }
          : String(url).endsWith('/points/query') ? { result: { points: [point()] } } : { result: { config: { params: { vectors: { size: 3, distance: 'Cosine' } } } } };
      return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const found = await createExternalKnowledge([settings], env, mockFetch).search(scope, 'policy');
    assert.equal(found.hits.length, 1);
    const embedding = calls[1]!;
    assert.equal(calls[2]!.body.using, undefined);
    if (provider === 'openai') {
      assert.equal(embedding.url, 'https://api.openai.com/v1/embeddings');
      assert.equal(embedding.body.model, 'text-embedding-3-small');
      assert.equal(embedding.body.dimensions, 3);
      assert.equal(embedding.headers.get('authorization'), 'Bearer synthetic-embedding-key');
    } else {
      assert.equal(embedding.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent');
      assert.equal(embedding.body.outputDimensionality, 3);
      assert.equal(embedding.body.taskType, 'RETRIEVAL_QUERY');
      assert.equal(embedding.headers.get('x-goog-api-key'), 'synthetic-embedding-key');
    }
  }
});
