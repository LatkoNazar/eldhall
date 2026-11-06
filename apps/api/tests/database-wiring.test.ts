import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabaseIntegrations } from '../src/integrations/database.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import type { BusinessIntegrations, BusinessTool } from '../src/integrations/mcp.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { seedData } from '../src/modules/support/seed.js';
import { DEFAULT_DATABASE_LIMITS } from '../src/modules/database/contracts.js';
import { IntegrationImportsService } from '../src/integrations/imports-service.js';
import { ManagedGatewayClient } from '../src/integrations/managed-client.js';

const businessId = seedData().businesses[0]!.id;
const source = { id: 'bank_records', label: 'Bank records', businessId, credentialEnv: 'BANK_READ_DATABASE_URL' };
const config = supportConfigSchema.parse({ databaseSources: [source] });
const tool = (integrationId: string): BusinessTool => ({ integrationId, name: 'ordinary_tool', description: 'Synthetic fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });

test('database sources require explicit separate credentials without exposing their value', async () => {
  const store = new MemorySupportStore(seedData());
  const base: BusinessIntegrations = { forContext: () => ({ tools: [], callTool: async () => null }) };
  await assert.rejects(createDatabaseIntegrations(config, { DATABASE_URL: 'postgresql://wrong@server/business' }, store, base), /credential reference/);
  await assert.rejects(createDatabaseIntegrations(config, { BANK_READ_DATABASE_URL: 'https://secret-value@example.test' }, store, base), error => error instanceof Error && !error.message.includes('secret-value'));
});

test('database namespace has exclusive read routing and never dispatches a business write', async () => {
  const store = new MemorySupportStore(seedData());
  let calls = 0;
  const base: BusinessIntegrations = { forContext: () => ({
    tools: [tool('ordinary'), tool(source.id)],
    callTool: async () => { calls++; return { forwarded: true }; },
    executeAction: async () => { calls++; return { status: 'executed', data: {} }; },
  }) };
  // An unreachable synthetic endpoint proves listing/disabled calls never acquire a connection.
  const f = await createDatabaseIntegrations(config, { BANK_READ_DATABASE_URL: 'postgresql://synthetic_reader@127.0.0.1:1/synthetic' }, store, base);
  try {
    const context = { businessId, customerId: seedData().customers[0]!.id, assertActive: async () => undefined };
    const scoped = f.integrations.forContext(context);
    assert.deepEqual((await scoped.listTools!()).map(row => row.integrationId), ['ordinary']);
    assert.deepEqual(await scoped.callTool('ordinary', 'ordinary_tool', {}), { forwarded: true });
    await assert.rejects(scoped.executeAction!({ integrationId: source.id }, 'synthetic-action'), /cannot execute business actions/);
    await assert.rejects(scoped.callTool(source.id, 'query_database', { query: 'SELECT * FROM payments' }), /disabled/);
    assert.equal(calls, 1);
    const settings = await store.settings(businessId);
    await store.saveSettings({ ...settings, version: settings.version + 1, databaseInvestigation: { enabled: true, limits: DEFAULT_DATABASE_LIMITS } }, settings.version);
    const tools = await scoped.listTools!();
    assert.deepEqual(tools.map(row => row.name), ['ordinary_tool', 'describe_database', 'query_database']);
    assert.equal(JSON.stringify(tools).includes('postgresql:'), false);
    assert.deepEqual(f.databaseInvestigations.getSources(seedData().businesses[1]!.id), []);
  } finally { await f.databaseInvestigations.close(); }
});

test('OpenAPI onboarding refuses database-reserved IDs before any sidecar request', async () => {
  const store = new MemorySupportStore(seedData());
  const base: BusinessIntegrations = { forContext: () => ({ tools: [], callTool: async () => null }) };
  const client = new ManagedGatewayClient({ url: 'http://127.0.0.1:1', token: 'synthetic-token-that-never-leaves-this-test', allowInsecureHttp: true });
  const service = new IntegrationImportsService(store.integrationStore, client, base, [[businessId, source.id]]);
  await assert.rejects(service.prepare(businessId, { integrationId: source.id, specUrl: 'https://example.test/openapi.json', credentialProfileId: 'test' }), /reserved/);
});
