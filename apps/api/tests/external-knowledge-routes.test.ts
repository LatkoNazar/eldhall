import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel } from '../src/modules/agent/model.js';
import { configureKnowledge } from '../src/modules/knowledge/runtime.js';
import type { ExternalKnowledge } from '../src/modules/knowledge/qdrant.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

test('external KB routes preserve business scope, expose read-only metadata, and never reindex the remote collection', async () => {
  const store = new MemorySupportStore(seedData());
  const businessId = (await store.businessesList())[0]!.id;
  const other = (await store.businessesList())[1]!.id;
  let calls = 0;
  let unavailable = false;
  const external: ExternalKnowledge = {
    hasBusiness: id => id === businessId,
    describe: id => id === businessId ? { id: 'company', collection: 'central', embedder: 'local:existing:384' } : undefined,
    search: async scope => {
      calls++;
      assert.deepEqual(scope, { businessId, plan: 'Pro' });
      if (unavailable) throw new Error('Private upstream response with credentials');
      return { hits: [{ id: 'external:company:1', title: 'Central article', content: 'Approved answer', version: 1, section: 'Help' }], refs: [] };
    },
    validate: async () => true,
  };
  configureKnowledge({ external });
  const model = new RulesModel();
  const harness = new SupportHarness({ store, model, fallback: model, provider: new SimulatedPaymentProvider(), externalKnowledge: external, timeoutMs: 500 });
  const app = await createApp(settingsFrom({ API_TOKEN: 't', OPERATOR_TOKEN: 'operator-token' }), { store: {} as never, dispatch: async () => undefined, checks: {}, support: { harness, store } });
  const headers = { host: 'testserver', authorization: 'Bearer operator-token' };
  try {
    const path = `/api/v1/knowledge/search?businessId=${businessId}&q=hours&plan=Pro&audience=any`;
    assert.equal((await app.inject({ url: path, headers: { host: 'testserver' } })).statusCode, 401);
    assert.equal(calls, 0);
    const index = await app.inject({ url: `/api/v1/knowledge/index?businessId=${businessId}`, headers });
    assert.equal(index.json().vectorStore, 'qdrant');
    assert.equal(index.json().readOnly, true);
    assert.equal(index.json().published, null);
    const found = await app.inject({ url: path, headers });
    assert.equal(found.statusCode, 200);
    assert.equal(found.json().mode, 'external');
    assert.equal(found.json().hits[0].content, 'Approved answer');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/knowledge/reindex?businessId=${businessId}`, headers, payload: {} })).statusCode, 409);
    assert.equal(calls, 1);
    const local = await app.inject({ url: `/api/v1/knowledge/search?businessId=${other}&q=hours`, headers });
    assert.equal(local.json().mode, 'hybrid');
    assert.equal(calls, 1);
    unavailable = true;
    const error = await app.inject({ url: path, headers });
    assert.equal(error.statusCode, 502);
    assert.doesNotMatch(error.body, /Private upstream|credentials/);
  } finally { await app.close(); configureKnowledge({ external: undefined }); }
});
