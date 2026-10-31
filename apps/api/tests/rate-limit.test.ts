import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { fixedWindowLimiter } from '../src/modules/support/rate-limit.js';

test('chat POSTs are rate limited per customer session', async () => {
  const store = new MemorySupportStore();
  await store.reset(seedData());
  const harness = new SupportHarness({ store, model: new RulesModel(), fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 200 });
  const app = await createApp(settingsFrom({ API_TOKEN: 't', OPERATOR_TOKEN: 'op-token' }), { store: {} as never, dispatch: async () => undefined, checks: {}, support: { harness, store } });
  const post = (session: string) => app.inject({ method: 'POST', url: '/api/v1/chat/cases', headers: { host: 'testserver', 'x-customer-session': session } });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await post('demo-olena')).statusCode, 201);
    const limited = await post('demo-olena');
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), { detail: 'Too many requests' });
    assert.ok(Number(limited.headers['retry-after']) > 0);
    const other = seedData().customers.find(c => c.sessionToken !== 'demo-olena')!.sessionToken;
    const created = await post(other);
    assert.equal(created.statusCode, 201);
    // GET polling is outside the limiter even after the session's POST window is spent.
    for (let i = 0; i < 25; i++) await post(other);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/chat/cases/${created.json().id}`, headers: { host: 'testserver', 'x-customer-session': other } })).statusCode, 200);
    // A direct caller cannot rotate a forwarding header to bypass the socket IP limit.
    const viaProxy = (ip: string) => app.inject({ method: 'POST', url: '/api/v1/chat/cases', headers: { host: 'testserver', 'x-forwarded-for': ip } });
    for (let i = 0; i < 60; i++) await viaProxy('203.0.113.1');
    assert.equal((await viaProxy('203.0.113.1')).statusCode, 429);
    assert.equal((await viaProxy('203.0.113.2')).statusCode, 429);
    assert.notEqual((await app.inject({ method: 'POST', url: '/api/v1/chat/cases', remoteAddress: '203.0.113.3', headers: { host: 'testserver' } })).statusCode, 429);
  } finally {
    await app.close();
  }
});

test('fixed windows bound identity storage, preserve limits at capacity, and expire', () => {
  const hit = fixedWindowLimiter(2);
  assert.equal(hit('first', 1, 0), 0);
  assert.equal(hit('second', 1, 0), 0);
  for (let i = 0; i < 100; i++) assert.equal(hit(`rotating-${i}`, 1, 0), 60);
  assert.equal(hit('first', 1, 0), 60);
  assert.equal(hit('first', 1, 59_000), 1);
  assert.equal(hit('new', 1, 60_000), 0);
  assert.equal(hit('first', 1, 60_000), 0);
});
