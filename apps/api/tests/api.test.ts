import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { MemoryStore } from './helpers.js';

const authorization = { authorization: 'Bearer test-token', host: 'testserver' };

test('HTTP contract, strict validation, authorization, not found and queue failure', async () => {
  const store = new MemoryStore();
  const app = await createApp(settingsFrom({ API_TOKEN: 'test-token' }), { store, dispatch: async () => undefined, checks: {} });
  try {
    for (const header of [undefined, 'Basic test-token', 'Bearer incorrect']) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: { host: 'testserver', ...(header ? { authorization: header } : {}) }, payload: { text: 'hello' } });
      assert.equal(response.statusCode, 401);
      assert.equal(response.headers['www-authenticate'], 'Bearer');
      assert.deepEqual(response.json(), { detail: 'Invalid API token' });
    }
    for (const payload of [{ text: '' }, { text: 'x'.repeat(10001) }, { text: 'hi', operation: 'delete' }, { text: 'hi', unknown: true }, { text: 123 }, { text: null }, { operation: 'reverse' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: authorization, payload });
      assert.equal(response.statusCode, 422, response.body);
      assert.ok(Array.isArray(response.json().detail));
    }
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: authorization, payload: { text: 'hello' } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const job = accepted.json();
    assert.equal(job.operation, 'uppercase');
    assert.equal(job.status, 'queued');
    assert.equal(job.result, null);
    assert.deepEqual(Object.keys(job).sort(), ['id', 'status', 'text', 'operation', 'result', 'error', 'created_at', 'updated_at'].sort());
    const read = await app.inject({ url: `/api/v1/jobs/${job.id}`, headers: authorization });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.json(), job);
    assert.equal((await app.inject({ url: '/api/v1/jobs/not-uuid', headers: authorization })).statusCode, 422);
    const missing = await app.inject({ url: '/api/v1/jobs/00000000-0000-0000-0000-000000000000', headers: authorization });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { detail: 'Job not found' });
    const astral = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: authorization, payload: { text: '🌍'.repeat(10000) } });
    assert.equal(astral.statusCode, 202);
  } finally { await app.close(); }
  const failed = await createApp(settingsFrom({ API_TOKEN: 'test-token' }), { store, dispatch: async () => { throw new Error('password'); }, checks: {} });
  try {
    const response = await failed.inject({ method: 'POST', url: '/api/v1/jobs', headers: authorization, payload: { text: 'hello' } });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { detail: 'Queue unavailable; please retry later' });
    assert.equal([...store.jobs.values()].at(-1)?.status, 'failed');
  } finally { await failed.close(); }
});

test('liveness, readiness redaction, host filtering and CORS', async () => {
  const app = await createApp(settingsFrom({ CORS_ORIGINS: '["https://ui.example.com"]' }), {
    store: new MemoryStore(), dispatch: async () => undefined,
    checks: { postgres: async () => undefined, redis: async () => { throw new Error('secret-password'); } },
  });
  try {
    assert.deepEqual((await app.inject({ url: '/health/live' })).json(), { status: 'ok' });
    const ready = await app.inject({ url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'unavailable', dependencies: { postgres: 'ok', redis: 'unavailable' } });
    assert.equal(ready.body.includes('secret-password'), false);
    assert.equal((await app.inject({ url: '/health/live', headers: { host: 'untrusted.example' } })).statusCode, 400);
    const origin = await app.inject({ url: '/health/live', headers: { origin: 'https://ui.example.com' } });
    assert.equal(origin.headers['access-control-allow-origin'], 'https://ui.example.com');
    const foreign = await app.inject({ url: '/health/live', headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/jobs', headers: { origin: 'https://ui.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(preflight.statusCode, 200);
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
    const rejectedPreflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/jobs', headers: { origin: 'https://evil.example', 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'x-dangerous' } });
    assert.equal(rejectedPreflight.statusCode, 400);
    assert.equal(rejectedPreflight.headers['access-control-allow-origin'], undefined);
    assert.equal((await app.inject({ url: '/openapi.json' })).statusCode, 200);
  } finally { await app.close(); }
});

test('healthy readiness and production docs disabled', async () => {
  const app = await createApp(settingsFrom({ ENVIRONMENT: 'production', POSTGRES_PASSWORD: 'p'.repeat(32), REDIS_PASSWORD: 'r'.repeat(32), API_TOKEN: 't'.repeat(32), SUPPORT_STORE: 'postgres' }), {
    store: new MemoryStore(), dispatch: async () => undefined, checks: { postgres: async () => 1, redis: async () => 'PONG' },
  });
  try {
    assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/docs' })).statusCode, 404);
    assert.equal((await app.inject({ url: '/openapi.json' })).statusCode, 404);
  } finally { await app.close(); }
});

test('configured external clients can send customer sessions and PATCH; unconfigured preflights are denied', async () => {
  const origin = 'https://widget.example.com';
  const app = await createApp(settingsFrom({ CORS_ORIGINS: JSON.stringify([origin]) }), { store: new MemoryStore(), dispatch: async () => undefined, checks: {} });
  const preflight = (overrides: Record<string, string> = {}) => app.inject({
    method: 'OPTIONS', url: '/api/v1/chat/cases',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, X-Customer-Session', ...overrides },
  });
  try {
    const customer = await preflight();
    assert.equal(customer.statusCode, 200);
    assert.equal(customer.headers['access-control-allow-origin'], origin);
    assert.equal(customer.headers['access-control-allow-credentials'], undefined);
    assert.match(String(customer.headers['access-control-allow-headers']), /X-Customer-Session/);
    assert.match(String(customer.headers.vary), /Origin/);
    const patch = await app.inject({
      method: 'OPTIONS', url: '/api/v1/settings',
      headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type' },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.headers['access-control-allow-methods'], 'GET, POST, PATCH, PUT');
    const guardUpdate = await app.inject({ method: 'OPTIONS', url: '/api/v1/guards/database', headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(guardUpdate.statusCode, 200);
    for (const [headers, failure] of [
      [{ origin: 'https://unconfigured.example' }, 'origin'],
      [{ 'access-control-request-method': 'DELETE' }, 'method'],
      [{ 'access-control-request-headers': 'x-customer-session,x-unconfigured' }, 'headers'],
    ] as const) {
      const denied = await preflight(headers);
      assert.equal(denied.statusCode, 400, denied.body);
      assert.equal(denied.body, `Disallowed CORS ${failure}`);
      assert.equal(denied.headers['access-control-allow-credentials'], undefined);
      if (failure === 'origin') assert.equal(denied.headers['access-control-allow-origin'], undefined);
    }
  } finally { await app.close(); }
});

test('explicit wildcard CORS origins preserve the Python allow-all contract without credentials', async () => {
  const app = await createApp(settingsFrom({ CORS_ORIGINS: '["*"]' }), { store: new MemoryStore(), dispatch: async () => undefined, checks: {} });
  try {
    const simple = await app.inject({ url: '/health/live', headers: { origin: 'https://any.example' } });
    assert.equal(simple.headers['access-control-allow-origin'], '*');
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/jobs', headers: { origin: 'https://any.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.statusCode, 200);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  } finally { await app.close(); }
});
