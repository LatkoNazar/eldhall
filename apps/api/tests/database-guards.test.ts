import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { seedData } from '../src/modules/support/seed.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { supportRoutes } from '../src/modules/support/routes.js';
import { DEFAULT_DATABASE_LIMITS } from '../src/modules/database/contracts.js';
import { databaseInvestigationPolicy } from '../src/modules/support/database-guards.js';
import { supportConfigSchema } from '../src/integrations/config.js';

const businessId = seedData().businesses[0]!.id;
const foreignId = seedData().businesses[1]!.id;
const headers = { authorization: 'Bearer synthetic-database-key' };
const url = '/api/v1/guards/database?businessId=' + businessId;
async function fixture(configured = true) {
  const store = new MemorySupportStore(seedData());
  const model = new RulesModel();
  const harness = new SupportHarness({ store, model, fallback: model, workspaceBusinessId: businessId, provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const app = Fastify();
  await app.register(supportRoutes, {
    support: { store, harness, workspaceBusinessId: businessId, databaseInvestigations: {
      getSources: () => configured ? [{ id: 'bank_data', label: 'Bank records', status: 'configured' as const }] : [],
      close: async () => undefined,
    } }, operatorToken: 'synthetic-database-key', demoResetEnabled: false,
  });
  return { app, store };
}

test('database guards require staff and current workspace; defaults do not enable data access', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    assert.equal((await f.app.inject({ url: url.replace(businessId, foreignId), headers })).statusCode, 404);
    const response = await f.app.inject({ url, headers });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().constraints, { readOnly: true, scope: 'current_customer' });
    assert.equal(response.json().enabled, false);
    assert.deepEqual(response.json().limits, DEFAULT_DATABASE_LIMITS);
    assert.equal(response.body.includes('credentialEnv'), false);
  } finally { await f.app.close(); }
});

test('guard writes reject editable identity, unbounded workload and absent data sources', async () => {
  const f = await fixture(false);
  try {
    for (const payload of [
      { version: 1, enabled: false, limits: DEFAULT_DATABASE_LIMITS, constraints: { readOnly: false } },
      { version: 1, enabled: false, limits: { ...DEFAULT_DATABASE_LIMITS, timeoutMs: 60000 } },
      { version: 1, enabled: false, limits: { ...DEFAULT_DATABASE_LIMITS, maxRows: 0 } },
      { version: 1, enabled: true, limits: DEFAULT_DATABASE_LIMITS },
    ]) assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload })).statusCode, 422);
    assert.equal((await f.store.settings(businessId)).version, 1);
  } finally { await f.app.close(); }
});

test('database guards use settings CAS, preserve unrelated guards and survive a general settings save', async () => {
  const f = await fixture();
  try {
    const limits = { ...DEFAULT_DATABASE_LIMITS, maxRows: 42 };
    const response = await f.app.inject({ method: 'PUT', url, headers, payload: { version: 1, enabled: true, limits } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().version, 2);
    assert.deepEqual((await f.store.business(businessId))!.policy.databaseInvestigation, { enabled: true, limits });
    assert.equal((await f.app.inject({ method: 'PUT', url, headers, payload: { version: 1, enabled: false, limits } })).statusCode, 409);
    const current = await f.store.settings(businessId);
    const { databaseInvestigation: omitted, ...ordinarySettings } = current;
    assert.equal(omitted?.enabled, true);
    await f.store.saveSettings({ ...ordinarySettings, version: 3, tone: 'neutral' }, 2);
    assert.deepEqual((await f.store.settings(businessId)).databaseInvestigation, { enabled: true, limits });
    assert.equal((await f.store.settings(foreignId)).databaseInvestigation, undefined);
  } finally { await f.app.close(); }
});

test('persisted invalid database policy fails closed rather than enabling defaults', () => {
  assert.throws(() => databaseInvestigationPolicy({ enabled: true, limits: { ...DEFAULT_DATABASE_LIMITS, maxBytes: 10000000 } }));
  assert.throws(() => databaseInvestigationPolicy({ enabled: true }));
});

test('database config reserves integration identity and validates ownership without including credentials', () => {
  const source = { id: 'bank_data', label: 'Bank records', businessId, credentialEnv: 'BANK_READ_DATABASE_URL' };
  const parsed = supportConfigSchema.parse({ databaseSources: [source] });
  assert.equal(parsed.databaseSources[0]!.ownership.customerColumn, 'customer_id');
  assert.equal(parsed.databaseSources[0]!.schema, 'public');
  assert.throws(() => supportConfigSchema.parse({ databaseSources: [source, source] }));
  assert.throws(() => supportConfigSchema.parse({ databaseSources: [{ ...source, ownership: { customerColumn: 'identity', businessColumn: 'identity' } }] }));
  assert.throws(() => supportConfigSchema.parse({ databaseSources: [{ ...source, credentialEnv: 'postgresql://secret@host/db' }] }));
});
