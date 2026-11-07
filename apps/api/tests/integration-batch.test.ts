import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import pg from 'pg';
import { createCatalogIntegration } from '../src/integrations/catalog.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { createDatabaseIntegrations } from '../src/integrations/database.js';
import { ManagedGatewayClient } from '../src/integrations/managed-client.js';
import { withManagedIntegrations } from '../src/integrations/managed-runtime.js';
import { manifestSchema } from '../src/integrations/manifest.js';
import { combineIntegrations, createBusinessIntegrations, type BusinessIntegrations, type BusinessIntegrationContext } from '../src/integrations/mcp.js';
import { fingerprint, type IntegrationPolicy } from '../src/integrations/permissions.js';
import { HarnessError, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { seedData } from '../src/modules/support/seed.js';

const seed = seedData();
const businessId = seed.businesses[0]!.id;
const customer = seed.customers[0]!;
const context = (overrides: Partial<BusinessIntegrationContext> = {}): BusinessIntegrationContext => ({ businessId, customerId: customer.id, assertActive: async () => undefined, ...overrides });
const decision: AgentDecision = { intent: 'other', summary: 'Review the order status', reasoning: 'Scoped order investigation', sentiment: { label: 'calm', urgency: 'low' }, reply: 'A specialist can review the order.', action: null };

async function fixture() {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('../../../examples/orders/manifest.json', import.meta.url), 'utf8')));
  const store = new MemorySupportStore(seed), registry = store.integrationStore;
  const policy: IntegrationPolicy = { businessId, integrationId: manifest.integrationId, manifestHash: manifest.manifestHash, enabled: true, policyRevision: 1, defaultMode: 'deny', groups: [], operations: manifest.operations.map(op => ({ operationKey: op.operationKey, enabled: true, reviewedOperationHash: op.operationHash, mode: 'auto' })) };
  await registry.bootstrap({ businessId, manifest, policy, connectionRevision: '1', connectionHash: fingerprint('synthetic-connection') });
  await registry.change(businessId, manifest.integrationId, 1, 'operator:test', 'integration.activated', state => ({ ...state, enabled: true, activeManifestHash: manifest.manifestHash, policy }));
  const config = { businessId, url: 'https://sidecar.example.invalid/mcp', credential: 'synthetic-sidecar-token', manifest, policy, registry, connectionRevision: '1', upstreamTargetFingerprint: fingerprint('synthetic-target') };
  const integrations = createCatalogIntegration(config);
  const read = manifest.operations.find(op => op.effect === 'read')!;
  const changeMode = async (mode: 'auto' | 'ask' | 'deny') => {
    const old = (await registry.get(businessId, manifest.integrationId))!;
    return registry.change(businessId, manifest.integrationId, old.version, 'operator:test', 'integration.policy_changed', state => ({ ...state, policy: { ...state.policy, policyRevision: state.policy.policyRevision + 1, operations: state.policy.operations.map(op => op.operationKey === read.operationKey ? { ...op, mode } : op) } }));
  };
  return { store, registry, manifest, config, integrations, read, changeMode };
}

test('batch capability requires a current persisted exact reviewed read in Auto, not method or a static hint', async () => {
  const f = await fixture();
  const observed: unknown[][] = [];
  const scoped = f.integrations.forContext(context({ rememberPolicy: (...values) => { observed.push(values); } }));
  assert.equal(await scoped.canBatchRead!(f.manifest.integrationId, f.read.toolName), true);
  assert.deepEqual(observed, [[f.manifest.integrationId, f.manifest.manifestHash, '1', 1]]);
  assert.equal((await scoped.listTools!()).find(tool => tool.name === f.read.toolName)?.batchRead, true);
  for (const op of f.manifest.operations.filter(op => op.effect !== 'read')) assert.equal(await scoped.canBatchRead!(f.manifest.integrationId, op.toolName), false, op.effect);
  assert.equal(await scoped.canBatchRead!(f.manifest.integrationId, 'unregistered_read'), false);
  assert.equal(await scoped.canBatchRead!('foreign-integration', f.read.toolName), false);
  for (const mode of ['ask', 'deny'] as const) {
    await f.changeMode(mode);
    assert.equal(await scoped.canBatchRead!(f.manifest.integrationId, f.read.toolName), false, mode);
    assert.equal((await scoped.listTools!()).some(tool => tool.name === f.read.toolName && tool.batchRead), false);
  }
  await f.changeMode('auto');
  assert.equal(await scoped.canBatchRead!(f.manifest.integrationId, f.read.toolName), true);
  const current = (await f.registry.get(businessId, f.manifest.integrationId))!;
  await f.registry.change(businessId, f.manifest.integrationId, current.version, 'operator:test', 'integration.policy_changed', state => ({ ...state, policy: { ...state.policy, operations: state.policy.operations.map(op => op.operationKey === f.read.operationKey ? { ...op, reviewedOperationHash: null } : op) } }));
  assert.equal(await scoped.canBatchRead!(f.manifest.integrationId, f.read.toolName), false, 'unreviewed current definition');
  const staticCatalog = createCatalogIntegration({ ...f.config, registry: undefined }).forContext(context());
  assert.equal(await staticCatalog.canBatchRead!(f.manifest.integrationId, f.read.toolName), false, 'static Auto is not a persisted permission proof');
  const legacy = createBusinessIntegrations(supportConfigSchema.parse({ integrations: [{ id: 'legacy_orders', businessId, url: 'https://legacy.example.invalid/mcp', tools: [{ name: f.read.toolName, description: f.read.description, inputSchema: f.read.inputSchema, scopeBindings: { businessId: 'trusted_business', customerId: 'trusted_customer' }, outputFields: f.read.outputFields, access: 'read' }] }] }), {});
  const legacyRoute = combineIntegrations([{ owns: [[businessId, 'legacy_orders']], integrations: legacy }]).forContext(context());
  assert.equal(await legacyRoute.canBatchRead!('legacy_orders', f.read.toolName), false, 'legacy read access is not a current Auto policy proof');
  const foreign = f.integrations.forContext(context({ businessId: seed.businesses[1]!.id }));
  assert.equal(await foreign.canBatchRead!(f.manifest.integrationId, f.read.toolName), false);
});

test('combined and managed wrappers preserve exact capability routing while database sources never opt in or connect', async () => {
  const f = await fixture();
  const combined = combineIntegrations([{ owns: [[businessId, f.manifest.integrationId]], integrations: f.integrations }]);
  assert.equal(await combined.forContext(context()).canBatchRead!(f.manifest.integrationId, f.read.toolName), true);
  assert.equal(await combined.forContext(context()).canBatchRead!('not-owned', f.read.toolName), false);
  assert.equal(await combined.forContext(context({ businessId: seed.businesses[1]!.id })).canBatchRead!(f.manifest.integrationId, f.read.toolName), false);
  let requests = 0, installs = 0;
  const client = new ManagedGatewayClient({ url: 'https://manager.example.invalid', token: 'synthetic-management-token-32-characters', allowInsecureHttp: false }, async () => { requests++; throw new Error('Unexpected network'); });
  const ensure = mock.method(client, 'ensure', async () => { installs++; return 'https://manager.example.invalid/managed/mcp'; });
  const managed = withManagedIntegrations(combined, f.registry, client);
  assert.equal(await managed.forContext(context()).canBatchRead!(f.manifest.integrationId, f.read.toolName), true, 'static route delegates without an install');
  assert.equal(installs, 0);
  const previous = (await f.registry.get(businessId, f.manifest.integrationId))!;
  await f.registry.change(businessId, f.manifest.integrationId, previous.version, 'operator:test', 'integration.test_managed', state => ({ ...state, managedConnection: { kind: 'managed', sourceUrl: 'https://source.example.invalid/openapi.json', upstreamBaseUrl: 'https://upstream.example.invalid', credentialProfileId: 'none', principalId: 'synthetic', upstreamTargetFingerprint: f.config.upstreamTargetFingerprint, importId: randomUUID(), inventory: [] } }));
  assert.equal(await managed.forContext(context()).canBatchRead!(f.manifest.integrationId, f.read.toolName), true, 'managed route checks the real current catalog policy');
  assert.equal(installs, 1);
  const config = supportConfigSchema.parse({ databaseSources: [{ id: 'customer-db', label: 'Synthetic customer records', businessId, credentialEnv: 'BATCH_TEST_DATABASE' }] });
  let connections = 0;
  const connect = mock.method(pg.Pool.prototype, 'connect', () => { connections++; throw new Error('Unexpected database access'); });
  const database = await createDatabaseIntegrations(config, { BATCH_TEST_DATABASE: 'postgresql://synthetic@127.0.0.1:1/synthetic' }, f.store, managed);
  try {
    assert.equal(await database.integrations.forContext(context()).canBatchRead!('customer-db', 'query_database'), false);
    assert.equal(await database.integrations.forContext(context()).canBatchRead!('customer-db', 'describe_database'), false);
    assert.equal(await database.integrations.forContext(context()).canBatchRead!(f.manifest.integrationId, f.read.toolName), true);
    assert.equal(connections, 0); assert.equal(requests, 0);
  } finally { await database.databaseInvestigations.close(); connect.mock.restore(); ensure.mock.restore(); }
});

class ModernScriptedModel extends ScriptedModel { readonly contextProtocol = 'catalog-v1' as const; }
class CheckpointScriptedModel extends ModernScriptedModel { readonly requestCatalogProtocol = 'checkpoint-v1' as const; }

async function trackedCase(store: MemorySupportStore) {
  const supportCase = await store.createCase(businessId, customer.id);
  const source = await store.addMessage(supportCase.id, 'customer', 'Please investigate my order status');
  const lease = await store.acquireTurn(supportCase.id, randomUUID()); assert.ok(lease);
  try {
    const catalog = await store.requestCheckpoint(lease, source.id, { version: 0, syncState: 'current', changes: [{ localKey: 'order', title: 'Order investigation', goal: 'Check the order status', waitingOn: null, nextStep: null, sourceMessageIds: [source.id], dependencyIds: [], dependencyKeys: [] }] });
    return { supportCase, request: catalog.requests[0]! };
  } finally { await store.releaseTurn(lease); }
}

test('individual and bundled reads reject foreign-case and stale request revisions before dispatch', async t => {
  for (const bundle of [false, true]) for (const targetKind of ['foreign', 'stale'] as const) await t.test(`${bundle ? 'bundle' : 'individual'}: ${targetKind} request target`, async () => {
    const f = await fixture(), local = await trackedCase(f.store), foreign = await trackedCase(f.store);
    let dispatched = 0, rejected = false, effects = 0;
    const integrations: BusinessIntegrations = { forContext(ctx) { return { ...f.integrations.forContext(ctx), async callTool() { dispatched++; throw new Error('Invalid request target reached dispatch'); } }; } };
    const model = new CheckpointScriptedModel(async ctx => {
      const catalog = await ctx.checkpointRequests!({ version: ctx.requestCatalog!().version, syncState: 'current', changes: [{ localKey: 'order', id: local.request.id, expectedRevision: local.request.revision, title: local.request.title, goal: 'Check the order status including the latest shipment', waitingOn: null, nextStep: null, sourceMessageIds: [...local.request.sourceMessageIds, ctx.currentCustomerMessageId!], dependencyIds: [], dependencyKeys: [] }] });
      const current = catalog.requests.find(row => row.id === local.request.id)!;
      assert.equal(current.revision, local.request.revision + 1);
      const valid = { id: current.id, revision: current.revision };
      const invalid = targetKind === 'foreign' ? { id: foreign.request.id, revision: foreign.request.revision } : { id: local.request.id, revision: local.request.revision };
      const call = { integrationId: f.manifest.integrationId, name: f.read.toolName, input: { order_id: 'ORD-1001' } };
      await assert.rejects(bundle ? ctx.callBusinessTools!([{ ...call, requests: [valid] }, { ...call, requests: [invalid] }]) : ctx.callBusinessTool!(call.integrationId, call.name, call.input, undefined, [invalid]), error => error instanceof HarnessError && error.status === 409 && error.message === 'Read request links are stale or unavailable');
      rejected = true; return decision;
    });
    const harness = new SupportHarness({ store: f.store, model, fallback: new ScriptedModel(() => { throw new Error('Unexpected fallback'); }), integrations, timeoutMs: 1000, provider: { async refund() { effects++; throw new Error('Unexpected refund'); } } });
    await harness.runTurn(customer.sessionToken, local.supportCase.id, 'Please include the latest shipment in this investigation');
    assert.equal(rejected, true); assert.equal(dispatched, 0); assert.equal(effects, 0);
    assert.deepEqual(await f.store.proposals(local.supportCase.id), []);
    assert.deepEqual(await f.store.proposals(foreign.supportCase.id), []);
    const audit = await f.store.auditEvents(local.supportCase.id);
    assert.equal(audit.some(event => event.type === 'action.proposed'), false);
    assert.equal(audit.some(event => event.type === 'agent.activity' && event.data.summary === 'Bundled business read requested'), false, 'the valid first member is not dispatched before the invalid second is checked');
  });
});

test('lazy tool details refuse a revoked permission or a concurrently replaced reviewed schema', async t => {
  for (const race of ['revoked-before-load', 'schema-changed-during-load'] as const) await t.test(race, async () => {
    const f = await fixture(); let listed = 0, changes = 0, delivered = false, attempted = false, dispatched = 0;
    const replaceSchema = async () => {
      const manifest = structuredClone(f.manifest), operation = manifest.operations.find(op => op.operationKey === f.read.operationKey)!;
      assert.ok(operation.inputSchema.properties);
      operation.inputSchema.properties.include_tracking = { type: 'boolean' }; operation.parameters.include_tracking = 'query';
      operation.operationHash = fingerprint(operation, 'operationHash'); manifest.manifestHash = fingerprint(manifest, 'manifestHash');
      const validated = manifestSchema.parse(manifest), prior = (await f.registry.get(businessId, f.manifest.integrationId))!;
      const policy = { ...prior.policy, manifestHash: validated.manifestHash, policyRevision: prior.policy.policyRevision + 1, operations: validated.operations.map(op => ({ operationKey: op.operationKey, enabled: true, reviewedOperationHash: op.operationHash, mode: 'auto' as const })) };
      await f.registry.bootstrap({ businessId, manifest: validated, policy, connectionRevision: prior.connectionRevision, connectionHash: prior.connectionHash });
      const loaded = (await f.registry.get(businessId, f.manifest.integrationId))!;
      await f.registry.change(businessId, f.manifest.integrationId, loaded.version, 'operator:test', 'integration.activated', state => ({ ...state, enabled: true, draining: false, activeManifestHash: validated.manifestHash, policy }));
      changes++;
    };
    const integrations: BusinessIntegrations = { forContext(ctx) {
      const scoped = f.integrations.forContext(ctx);
      return { ...scoped, async listTools() { const tools = await scoped.listTools!(); listed++; if (race === 'schema-changed-during-load' && listed === 2) await replaceSchema(); return tools; }, async callTool() { dispatched++; throw new Error('Context loading dispatched a business tool'); } };
    } };
    const model = new ModernScriptedModel(async ctx => {
      assert.ok(ctx.contextCatalog!.tools.some(tool => tool.integrationId === f.manifest.integrationId && tool.name === f.read.toolName));
      if (race === 'revoked-before-load') { await f.changeMode('deny'); changes++; }
      attempted = true;
      await ctx.loadSupportContext!({ toolRefs: [{ integrationId: f.manifest.integrationId, name: f.read.toolName }] });
      delivered = true; return decision;
    });
    const harness = new SupportHarness({ store: f.store, model, fallback: new ScriptedModel(() => { throw new Error('Unexpected fallback'); }), integrations, timeoutMs: 1000, provider: { async refund() { throw new Error('Unexpected refund'); } } });
    const supportCase = await harness.openCase(customer.sessionToken);
    await assert.rejects(harness.runTurn(customer.sessionToken, supportCase.id, 'Please investigate this order'), error => error instanceof HarnessError && error.status === 409 && error.message === 'Integration policy changed');
    assert.equal(attempted, true); assert.equal(delivered, false); assert.equal(changes, 1); assert.equal(dispatched, 0);
    assert.deepEqual(await f.store.proposals(supportCase.id), []);
    if (race === 'schema-changed-during-load') {
      assert.ok(listed >= 2, 'replacement happens during the current tool inventory recheck');
      assert.notEqual((await f.registry.get(businessId, f.manifest.integrationId))!.loadedManifestHash, f.manifest.manifestHash);
    }
  });
});

test('harness batches keep the first policy tuple and refuse changed permissions before any proposal or dispatch', async t => {
  for (const phase of ['between-preflights', 'before-dispatch'] as const) for (const mode of ['ask', 'deny', 'auto'] as const) await t.test(`${phase}: Auto to ${mode} at a newer revision`, async () => {
    const f = await fixture();
    let checks = 0, changes = 0, dispatched = 0, effects = 0, armed = false;
    const integrations: BusinessIntegrations = { forContext(ctx) {
      const scoped = f.integrations.forContext({ ...ctx, assertActive: async () => {
        await ctx.assertActive();
        // Reproduce a policy edit after the active assertion but before the connector's
        // next registry read. A newer Auto tuple must not overwrite the first fence.
        if (armed) { armed = false; await f.changeMode(mode); changes++; }
      } });
      return { ...scoped, async canBatchRead(id, name) { checks++; if (checks === (phase === 'between-preflights' ? 2 : 3)) armed = true; return scoped.canBatchRead!(id, name); },
        async callTool() { dispatched++; throw new Error('Changed policy reached dispatch'); } };
    } };
    const model = new ModernScriptedModel(async ctx => {
      assert.ok(ctx.contextCatalog); assert.ok(ctx.callBusinessTools);
      await ctx.callBusinessTools([{ integrationId: f.manifest.integrationId, name: f.read.toolName, input: { order_id: 'ORD-1001' } }, { integrationId: f.manifest.integrationId, name: f.read.toolName, input: { order_id: 'ORD-1002' } }]);
      return decision;
    });
    const harness = new SupportHarness({ store: f.store, model, fallback: new RulesModel(), integrations, timeoutMs: 1000, provider: { async refund() { effects++; throw new Error('Unexpected refund'); } } });
    const supportCase = await harness.openCase(customer.sessionToken);
    await assert.rejects(harness.runTurn(customer.sessionToken, supportCase.id, 'Please investigate these two order statuses'), error => error instanceof HarnessError && error.status === 409 && error.message === 'Integration policy changed');
    assert.equal(changes, 1); assert.equal(dispatched, 0); assert.equal(effects, 0);
    assert.deepEqual(await f.store.proposals(supportCase.id), []);
    assert.equal((await f.store.auditEvents(supportCase.id)).some(event => event.type === 'action.proposed'), false);
  });
});
