import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { createSupportIntegrations } from '../src/integrations/catalog.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import type { Manifest } from '../src/integrations/manifest.js';
import { IntegrationError } from '../src/integrations/mcp.js';
import { fingerprint, type IntegrationPolicy, type PermissionDecision } from '../src/integrations/permissions.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { MemoryStore } from './helpers.js';

const seed = seedData();
const A = seed.businesses[0]!.id;
const B = seed.businesses[1]!.id;
const operatorToken = 'synthetic-admin-token-case-Sensitive';
const connectorToken = 'synthetic-connector-secret-do-not-return';
const privateUrl = 'https://private-sidecar.example.invalid/mcp';
const headers = { host: 'testserver', authorization: `Bearer ${operatorToken}` };
interface Summary { businessId: string; integrationId: string; enabled: boolean; draining: boolean; activeManifestHash: string | null; loadedManifestHash: string; connectionRevision: string; policyRevision: number; version: number; defaultMode: string }
interface PolicyResponse { integration: Summary; policy: IntegrationPolicy }
interface OperationsResponse { integration: Summary; groups: IntegrationPolicy['groups']; operations: (Manifest['operations'][number] & { enabled: boolean; reviewedOperationHash: string | null; mode: string; effective: PermissionDecision })[] }
const catalogUrl = (suffix = '', businessId = A, id = 'orders') => `/api/v1/integrations/${encodeURIComponent(id)}${suffix}?businessId=${businessId}`;

async function fixture() {
  const orders = new URL('../../../examples/orders/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', orders), 'utf8')) as Manifest;
  const importedPolicy = JSON.parse(await readFile(new URL('policy.json', orders), 'utf8')) as IntegrationPolicy;
  const config = supportConfigSchema.parse({ catalogs: [A, B].map(businessId => ({
    businessId, url: privateUrl, credentialEnv: 'ADMIN_TEST_SIDECAR_TOKEN', connectionRevision: '1',
    upstreamTargetFingerprint: fingerprint({ baseUrl: 'https://orders.example.invalid', principalId: 'synthetic-service-principal' }),
    manifest, policy: { ...structuredClone(importedPolicy), businessId, defaultMode: 'auto' },
  })) });
  const store = new MemorySupportStore(seed);
  await bootstrapSupportConfig(store, config);
  const integrations = createSupportIntegrations(config, { ADMIN_TEST_SIDECAR_TOKEN: connectorToken }, store.integrationStore);
  const readinessCalls: unknown[][] = [];
  let readinessError: Error | null = null;
  integrations.verifyCatalog = async (...args) => { readinessCalls.push(args); if (readinessError) throw readinessError; };
  const rules = new RulesModel();
  const harness = new SupportHarness({ store, model: rules, fallback: rules, provider: new SimulatedPaymentProvider(), timeoutMs: 1000, integrations });
  const app = await createApp(settingsFrom({ OPERATOR_TOKEN: operatorToken, DEMO_RESET_ENABLED: 'false' }), {
    store: new MemoryStore(), dispatch: async () => undefined, checks: {}, support: { store, harness, integrations },
  });
  const readPolicy = async (businessId = A) => {
    const result = await app.inject({ url: catalogUrl('/policy', businessId), headers });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<PolicyResponse>();
  };
  const operations = async (businessId = A) => {
    const result = await app.inject({ url: catalogUrl('/operations', businessId), headers });
    assert.equal(result.statusCode, 200, result.body);
    return result.json<OperationsResponse>();
  };
  const change = (method: 'PATCH' | 'POST', suffix: string, payload: unknown, businessId = A) => app.inject({ method, url: catalogUrl(suffix, businessId), headers, payload: payload as Record<string, unknown> });
  async function activate(businessId = A) {
    let current = await readPolicy(businessId);
    const configured = await change('PATCH', '/policy', { version: current.integration.version, defaultMode: 'deny', groups: [{ id: 'orders', selector: { tag: 'Orders' }, mode: 'ask' }], operations: manifest.operations.map(op => ({ operationKey: op.operationKey, mode: op.effect === 'read' ? 'auto' : 'inherit' })) }, businessId);
    assert.equal(configured.statusCode, 200, configured.body);
    current = configured.json<PolicyResponse>();
    const reviewed = await change('POST', '/review', { version: current.integration.version, manifestHash: manifest.manifestHash, operations: manifest.operations.filter(op => op.effect !== 'unknown').map(op => ({ operationKey: op.operationKey, operationHash: op.operationHash, enabled: true })) }, businessId);
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    current = reviewed.json<PolicyResponse>();
    const active = await change('POST', '/activate', { version: current.integration.version, manifestHash: manifest.manifestHash, connectionRevision: '1' }, businessId);
    assert.equal(active.statusCode, 200, active.body);
    return active.json<PolicyResponse>();
  }
  return { app, store, config, manifest, readPolicy, operations, change, activate, readinessCalls, rejectReadiness: (error: Error | null) => { readinessError = error; } };
}

async function createPending(f: Awaited<ReturnType<typeof fixture>>, businessId = A, approved = false) {
  const customer = seed.customers.find(row => row.businessId === businessId)!;
  const supportCase = await f.store.createCase(businessId, customer.id);
  const state = (await f.store.integrationStore.get(businessId, 'orders'))!;
  const operation = f.manifest.operations.find(row => row.effect === 'write')!;
  const args = { businessId, customerId: customer.id, caseId: supportCase.id, ownershipVersion: supportCase.ownershipVersion,
    integrationId: 'orders', operationKey: operation.operationKey, toolName: operation.toolName, title: operation.title,
    operationHash: operation.operationHash, manifestHash: f.manifest.manifestHash, connectionRevision: state.connectionRevision,
    policyRevision: state.policy.policyRevision, tags: operation.tags, effect: 'write', managed: true,
    input: { order_id: 'ORD-1001' }, expiresAt: new Date(Date.now() + 900_000).toISOString() };
  let proposal = await f.store.createProposal({ caseId: supportCase.id, tool: 'external_action', args, argsHash: fingerprint(args), risk: 'high', status: 'pending',
    policy: { allowed: true, requiresApproval: true, checks: [{ name: 'integration_permission', passed: true, detail: 'ask: reviewed orders operation' }] } });
  if (approved) { const decided = await f.store.decideProposal(proposal.id, proposal.argsHash, 'approved', 'operator:staff'); assert.ok(decided); proposal = decided; }
  return proposal;
}

test('integration admin: imports stay disabled/unreviewed and policy edits, exact review and readiness activation are separate', async () => {
  const f = await fixture();
  try {
    const initial = await f.readPolicy();
    assert.equal(initial.integration.enabled, false);
    assert.equal(initial.integration.activeManifestHash, null);
    assert.equal(initial.policy.defaultMode, 'deny');
    assert.ok(initial.policy.operations.every(op => !op.enabled && op.reviewedOperationHash === null && op.mode === 'inherit'));
    const before = await f.operations();
    assert.ok(before.operations.every(op => op.effective.mode === 'deny'));
    assert.deepEqual(before.operations.map(op => op.operationHash), f.manifest.operations.map(op => op.operationHash));
    assert.deepEqual(before.operations[0]!.inputSchema, f.manifest.operations[0]!.inputSchema);
    const configured = await f.change('PATCH', '/policy', { version: initial.integration.version, defaultMode: 'auto', groups: [] });
    assert.equal(configured.statusCode, 200, configured.body);
    const configuredState = configured.json<PolicyResponse>();
    assert.equal(configuredState.integration.enabled, false);
    assert.ok(configuredState.policy.operations.every(op => !op.enabled && op.reviewedOperationHash === null));
    const reviewedKeys = new Set(f.manifest.operations.filter(op => op.effect !== 'unknown').map(op => op.operationKey));
    const review = await f.change('POST', '/review', { version: configuredState.integration.version, manifestHash: f.manifest.manifestHash,
      operations: f.manifest.operations.filter(op => reviewedKeys.has(op.operationKey)).map(op => ({ operationKey: op.operationKey, operationHash: op.operationHash, enabled: true })) });
    assert.equal(review.statusCode, 200, review.body);
    const reviewed = review.json<PolicyResponse>();
    assert.equal(reviewed.integration.enabled, false);
    assert.ok(reviewed.policy.operations.every(op => reviewedKeys.has(op.operationKey) ? op.enabled && op.reviewedOperationHash !== null : !op.enabled && op.reviewedOperationHash === null));
    assert.ok((await f.operations()).operations.every(op => op.effective.mode === 'deny'));
    f.rejectReadiness(new IntegrationError('denied', `${connectorToken} at ${privateUrl}`));
    const failed = await f.change('POST', '/activate', { version: reviewed.integration.version, manifestHash: f.manifest.manifestHash, connectionRevision: '1' });
    assert.equal(failed.statusCode, 409);
    assert.deepEqual(failed.json(), { detail: 'Catalog readiness verification failed' });
    assert.equal((await f.readPolicy()).integration.version, reviewed.integration.version);
    f.rejectReadiness(null);
    const activated = await f.change('POST', '/activate', { version: reviewed.integration.version, manifestHash: f.manifest.manifestHash, connectionRevision: '1' });
    assert.equal(activated.statusCode, 200, activated.body);
    assert.equal(activated.json<PolicyResponse>().integration.activeManifestHash, f.manifest.manifestHash);
    assert.deepEqual(f.readinessCalls.at(-1), [A, 'orders', f.manifest.manifestHash, '1']);
    const executable = (await f.operations()).operations;
    assert.ok(executable.filter(op => reviewedKeys.has(op.operationKey)).every(op => op.effective.mode === 'auto'));
    assert.ok(executable.filter(op => !reviewedKeys.has(op.operationKey)).every(op => op.effective.mode === 'deny'));
    for (const result of [initial, before, configuredState, reviewed, activated.json()]) {
      const text = JSON.stringify(result);
      assert.ok(!text.includes(connectorToken) && !text.includes(privateUrl) && !text.includes('ADMIN_TEST_SIDECAR_TOKEN'));
      assert.ok(!text.includes('connectionHash'));
    }
  } finally { await f.app.close(); }
});

test('integration admin: compare-and-swap conflicts preserve the winner and group edits retain endpoint overrides', async () => {
  const f = await fixture();
  try {
    const first = await f.readPolicy();
    const read = f.manifest.operations.find(op => op.effect === 'read')!;
    const write = f.manifest.operations.find(op => op.effect === 'write')!;
    const responses = await Promise.all([
      f.change('PATCH', '/policy', { version: first.integration.version, defaultMode: 'ask', operations: [{ operationKey: read.operationKey, mode: 'auto' }] }),
      f.change('PATCH', '/policy', { version: first.integration.version, defaultMode: 'auto', operations: [{ operationKey: write.operationKey, mode: 'deny' }] }),
    ]);
    assert.deepEqual(responses.map(row => row.statusCode).sort(), [200, 409]);
    const winner = responses.find(row => row.statusCode === 200)!.json<PolicyResponse>();
    assert.deepEqual(await f.readPolicy(), winner);
    const beforeOperations = structuredClone(winner.policy.operations);
    const grouped = await f.change('PATCH', '/policy', { version: winner.integration.version, groups: [{ id: 'orders', selector: { tag: 'Orders' }, mode: 'deny' }] });
    assert.equal(grouped.statusCode, 200, grouped.body);
    assert.deepEqual(grouped.json<PolicyResponse>().policy.operations, beforeOperations);
    const stale = await f.change('PATCH', '/policy', { version: first.integration.version, defaultMode: 'deny', groups: [] });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(await f.readPolicy(), grouped.json<PolicyResponse>());
  } finally { await f.app.close(); }
});

test('integration admin: policy-only edits invalidate pending and approved snapshots with terminal customer messages and audit', async () => {
  const f = await fixture();
  try {
    const activeA = await f.activate(A);
    await f.activate(B);
    const pending = await createPending(f);
    const approved = await createPending(f, A, true);
    const other = await createPending(f, B);
    const changed = await f.change('PATCH', '/policy', { version: activeA.integration.version, defaultMode: 'ask' });
    assert.equal(changed.statusCode, 200, changed.body);
    const state = changed.json<PolicyResponse>();
    assert.equal(state.integration.activeManifestHash, activeA.integration.activeManifestHash);
    assert.equal(state.integration.policyRevision, activeA.integration.policyRevision + 1);
    for (const proposal of [pending, approved]) {
      assert.equal((await f.store.proposal(proposal.id))!.status, 'invalidated');
      const supportCase = (await f.store.getCase(proposal.caseId))!;
      assert.equal(supportCase.status, 'escalated');
      assert.equal(supportCase.ownership, 'staff');
      assert.equal((await f.store.messages(proposal.caseId)).length, 1);
      assert.match((await f.store.messages(proposal.caseId))[0]!.body, /не виконано/);
      assert.ok((await f.store.auditEvents(proposal.caseId)).some(event => event.type === 'action.invalidated' && event.data.proposalId === proposal.id));
      assert.equal(await f.store.claimExecution(proposal.id, proposal.argsHash, 'operator:staff'), null);
    }
    assert.equal((await f.store.proposal(other.id))!.status, 'pending');
    const events = await f.app.inject({ url: catalogUrl('/audit'), headers });
    assert.equal(events.statusCode, 200);
    assert.ok(events.json<{ events: { type: string; actor: string }[] }>().events.some(event => event.type === 'integration.policy_updated' && event.actor === 'operator:staff'));
  } finally { await f.app.close(); }
});

test('integration admin: disable drains new work and stale startup config does not re-enable or overwrite operator rules', async () => {
  const f = await fixture();
  try {
    const active = await f.activate();
    const proposal = await createPending(f, A, true);
    const disabled = await f.change('POST', '/disable', { version: active.integration.version, draining: true });
    assert.equal(disabled.statusCode, 200, disabled.body);
    const state = disabled.json<PolicyResponse>();
    assert.equal(state.integration.enabled, false);
    assert.equal(state.integration.draining, true);
    assert.equal((await f.store.proposal(proposal.id))!.status, 'invalidated');
    assert.ok((await f.operations()).operations.every(op => op.effective.mode === 'deny'));
    await bootstrapSupportConfig(f.store, f.config);
    assert.deepEqual(await f.readPolicy(), state);
    const conflicting = structuredClone(f.config);
    conflicting.catalogs[0]!.policy.defaultMode = 'ask';
    await assert.rejects(bootstrapSupportConfig(f.store, conflicting), /Same bootstrap policy revision has different content/);
    assert.deepEqual(await f.readPolicy(), state);
    const stopped = await f.change('POST', '/disable', { version: state.integration.version, draining: false });
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(stopped.json<PolicyResponse>().integration.draining, false);
    assert.equal(stopped.json<PolicyResponse>().integration.enabled, false);
  } finally { await f.app.close(); }
});

test('integration admin: identical integration ids in different businesses have independent state and deployment staff can select either', async () => {
  const f = await fixture();
  try {
    const beforeB = await f.readPolicy(B);
    await f.activate(A);
    assert.deepEqual(await f.readPolicy(B), beforeB);
    for (const businessId of [A, B]) {
      const list = await f.app.inject({ url: `/api/v1/integrations?businessId=${businessId}`, headers });
      assert.equal(list.statusCode, 200);
      assert.deepEqual(list.json<{ integrations: Summary[] }>().integrations.map(item => [item.businessId, item.integrationId]), [[businessId, 'orders']]);
    }
    assert.ok((await f.operations(A)).operations.some(op => op.effective.mode === 'auto'));
    assert.ok((await f.operations(B)).operations.every(op => op.effective.mode === 'deny'));
    assert.equal((await f.app.inject({ url: catalogUrl('/policy', B, 'not-configured'), headers })).statusCode, 404);
  } finally { await f.app.close(); }
});

test('integration admin: customer sessions and malformed staff auth cannot read or mutate administration', async () => {
  const f = await fixture();
  try {
    const before = await f.readPolicy();
    const routes = ['/api/v1/integrations?businessId=' + A, catalogUrl('/operations'), catalogUrl('/policy'), catalogUrl('/audit')];
    for (const credentials of [{}, { authorization: 'Bearer ' + seed.customers[0]!.sessionToken }, { 'x-customer-session': seed.customers[0]!.sessionToken }, { authorization: `Basic ${operatorToken}` }, { authorization: `Bearer ${operatorToken} ` }]) {
      for (const url of routes) {
        const result = await f.app.inject({ url, headers: { host: 'testserver', ...credentials } });
        assert.equal(result.statusCode, 401);
        assert.equal(result.headers['www-authenticate'], 'Bearer');
      }
      const changed = await f.app.inject({ method: 'PATCH', url: catalogUrl('/policy'), headers: { host: 'testserver', ...credentials }, payload: { version: before.integration.version, defaultMode: 'auto' } });
      assert.equal(changed.statusCode, 401);
    }
    assert.deepEqual(await f.readPolicy(), before);
    assert.deepEqual(f.readinessCalls, []);
  } finally { await f.app.close(); }
});

test('integration admin: invalid bodies/hashes/scopes are rejected without changing state or leaking connector secrets', async () => {
  const f = await fixture();
  try {
    const before = await f.readPolicy();
    const operation = f.manifest.operations[0]!;
    const payloads: { method: 'POST' | 'PATCH'; suffix: string; payload: Record<string, unknown>; status: number }[] = [
      { method: 'PATCH', suffix: '/policy', payload: { version: 1, defaultMode: 'inherit' }, status: 422 },
      { method: 'PATCH', suffix: '/policy', payload: { version: 1, credential: connectorToken, url: privateUrl }, status: 422 },
      { method: 'PATCH', suffix: '/policy', payload: { version: 1, operations: [{ operationKey: operation.operationKey, mode: 'auto' }, { operationKey: operation.operationKey, mode: 'deny' }] }, status: 422 },
      { method: 'PATCH', suffix: '/policy', payload: { version: 1, groups: [{ id: 'foreign', selector: { operationKeys: ['DELETE /foreign'] }, mode: 'auto' }] }, status: 422 },
      { method: 'POST', suffix: '/review', payload: { version: 1, manifestHash: f.manifest.manifestHash, operations: [{ operationKey: operation.operationKey, operationHash: 'f'.repeat(64), enabled: true }] }, status: 422 },
      { method: 'POST', suffix: '/review', payload: { version: 1, manifestHash: 'f'.repeat(64), operations: [{ operationKey: operation.operationKey, operationHash: operation.operationHash, enabled: true }] }, status: 409 },
      { method: 'POST', suffix: '/activate', payload: { version: 1, manifestHash: f.manifest.manifestHash, connectionRevision: '2' }, status: 409 },
      { method: 'POST', suffix: '/activate', payload: { version: 1, manifestHash: f.manifest.manifestHash, connectionRevision: 'invalid' }, status: 422 },
      { method: 'POST', suffix: '/disable', payload: { version: 1, draining: 'true' }, status: 422 },
    ];
    for (const row of payloads) {
      const result = await f.change(row.method, row.suffix, row.payload);
      assert.equal(result.statusCode, row.status, result.body);
      assert.ok(!result.body.includes(connectorToken) && !result.body.includes(privateUrl));
      assert.deepEqual(await f.readPolicy(), before);
    }
    assert.equal((await f.app.inject({ url: '/api/v1/integrations', headers })).statusCode, 422);
    assert.equal((await f.app.inject({ url: '/api/v1/integrations?businessId=bad', headers })).statusCode, 422);
    assert.equal((await f.app.inject({ url: catalogUrl('/policy', '99999999-9999-4999-8999-999999999999'), headers })).statusCode, 404);
    assert.deepEqual(f.readinessCalls, []);
  } finally { await f.app.close(); }
});
