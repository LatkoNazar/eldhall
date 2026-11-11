import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { manifestSchema } from '../src/integrations/manifest.js';
import { fingerprint, type IntegrationPolicy } from '../src/integrations/permissions.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel } from '../src/modules/agent/model.js';
import type { GuardDraftInput, GuardDraftModel } from '../src/modules/support/guard-drafts.js';
import { guardRuleSchema, type GuardRule } from '../src/modules/support/guards.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { supportRoutes } from '../src/modules/support/routes.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const description = 'Deny cancellation of orders in the orders integration.';
const headers = { authorization: 'Bearer synthetic-operator' };
const existingRule: GuardRule = { id: randomUUID(), kind: 'deny_action', definitionVersion: 1, enabled: true, name: 'Refund safety review', target: { tool: 'refund_payment' }, reason: 'Staff review in progress' };
const foreignRule: GuardRule = { ...existingRule, id: randomUUID(), name: 'FOREIGN_RULE_CANARY' };

async function fixture(model?: GuardDraftModel) {
  const seed = seedData(), [business, foreign] = seed.businesses;
  assert.ok(business && foreign);
  const store = new MemorySupportStore(seed);
  for (const [id, rule] of [[business.id, existingRule], [foreign.id, foreignRule]] as const) {
    const settings = await store.settings(id);
    await store.saveSettings({ ...settings, guards: [rule], guardRevision: 1, version: settings.version + 1 }, settings.version);
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('../../../examples/orders/manifest.json', import.meta.url), 'utf8')));
  const cancel = manifest.operations.find(operation => operation.toolName === 'cancel_order')!;
  const read = manifest.operations.find(operation => operation.toolName === 'get_order_status')!;
  const add = async (businessId: string, id: string) => {
    const scoped = { ...manifest, integrationId: id };
    scoped.manifestHash = fingerprint(scoped, 'manifestHash');
    const policy: IntegrationPolicy = { businessId, integrationId: id, manifestHash: scoped.manifestHash, enabled: true, policyRevision: 1, defaultMode: 'deny', groups: [],
      operations: scoped.operations.map(operation => {
        const reviewed = operation.operationKey === cancel.operationKey || operation.operationKey === read.operationKey;
        return { operationKey: operation.operationKey, enabled: reviewed, reviewedOperationHash: reviewed ? operation.operationHash : null, mode: operation.effect === 'read' ? 'auto' : 'ask' };
      }) };
    await store.integrationStore.bootstrap({ businessId, manifest: scoped, policy, connectionRevision: '1', connectionHash: fingerprint(id) });
    await store.integrationStore.change(businessId, id, 1, 'test', 'integration.activated', state => ({ ...state, enabled: true, activeManifestHash: scoped.manifestHash, policy }));
  };
  await add(business.id, manifest.integrationId);
  await add(foreign.id, 'foreign-orders');
  const rules = new RulesModel();
  const harness = new SupportHarness({ store, model: rules, fallback: rules, provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const app = Fastify();
  let skillCalls = 0;
  await app.register(supportRoutes, { operatorToken: 'synthetic-operator', demoResetEnabled: false, support: {
    store, harness, workspaceBusinessId: business.id, guardDraftModel: model,
    skillDraftModel: { async generate() { skillCalls++; throw new Error('Unexpected skill generation'); } },
  } });
  const url = `/api/v1/guards?businessId=${business.id}`;
  const generate = (payload: { description: string; guardId?: string }) => app.inject({ method: 'POST', url: `/api/v1/guards/draft?businessId=${business.id}`, headers, payload });
  const draft = { kind: 'deny_action', name: 'Deny cancellation', reason: 'Orders require manual handling', target: { tool: 'external_action', integrationId: manifest.integrationId, operationKey: cancel.operationKey } };
  return { app, store, business, foreign, url, generate, draft, read, skillCalls: () => skillCalls };
}

test('guard draft uses scoped rules and reviewed targets, then waits for explicit CAS save', async () => {
  let input: GuardDraftInput | undefined, output: unknown, calls = 0;
  const f = await fixture({ async generate(value) { input = value; calls++; return output; } });
  try {
    const before = await f.store.settings(f.business.id);
    assert.equal((await f.app.inject({ url: f.url, headers })).json().canGenerate, true);
    const foreignDraft = `/api/v1/guards/draft?businessId=${f.foreign.id}`;
    assert.equal((await f.app.inject({ method: 'POST', url: foreignDraft, payload: { description } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: foreignDraft, headers, payload: { description } })).statusCode, 404);
    assert.equal((await f.generate({ description, guardId: foreignRule.id })).statusCode, 404);
    assert.equal(calls, 0);

    output = { guard: f.draft };
    const created = await f.generate({ description });
    assert.equal(created.statusCode, 200, created.body);
    const proposed = guardRuleSchema.parse(created.json().guard);
    assert.equal(proposed.enabled, false);
    assert.notEqual(proposed.id, existingRule.id);
    assert.deepEqual(proposed.target, f.draft.target);
    assert.deepEqual(input?.existingGuards, [existingRule]);
    assert.deepEqual(input?.targets.integrations.map(row => [row.integrationId, row.operations.map(operation => operation.operationKey)]), [['orders', [f.draft.target.operationKey]]]);
    assert.doesNotMatch(JSON.stringify(input), /FOREIGN_RULE_CANARY|foreign-orders/);
    assert.deepEqual(await f.store.settings(f.business.id), before);

    output = { guard: { kind: existingRule.kind, name: 'Reworded refund restriction', target: existingRule.target, reason: existingRule.reason } };
    const edited = await f.generate({ description: 'Reword the refund restriction without changing what it covers.', guardId: existingRule.id });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().guard.id, existingRule.id);
    assert.equal(edited.json().guard.enabled, true);
    assert.equal(input?.editingGuardId, existingRule.id);
    assert.deepEqual(await f.store.settings(f.business.id), before);

    output = { guard: { ...f.draft, target: { ...f.draft.target, operationKey: f.read.operationKey } } };
    assert.equal((await f.generate({ description: 'Deny order status reads from the orders integration.' })).statusCode, 502);
    assert.deepEqual(await f.store.settings(f.business.id), before);

    const saved = await f.app.inject({ method: 'PUT', url: f.url, headers, payload: { version: before.version, rules: [existingRule, proposed] } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().canGenerate, true);
    assert.deepEqual((await f.store.settings(f.business.id)).guards, [existingRule, proposed]);
  } finally { await f.app.close(); }
});

test('unsupported, duplicate, invented, or model-owned guard fields never produce a writable draft', async () => {
  let output: unknown;
  const f = await fixture({ async generate() { return output; } });
  try {
    const before = await f.store.settings(f.business.id);
    for (const [guard, status, code, expected] of [
      [null, 422, 'guard_draft_unsupported', /one supported restriction/],
      [{ kind: 'amount_limit', name: 'Foreign currency cap', reason: 'Limit', target: { tool: 'refund_payment' }, maxAmountCents: 50000, currency: 'USD' }, 422, 'guard_draft_currency', /workspace currency/],
      [{ ...f.draft, target: { ...f.draft.target, integrationId: 'foreign-orders' } }, 502, undefined, /valid guard draft/],
      [{ ...f.draft, enabled: true }, 502, undefined, /valid guard draft/],
      [{ kind: existingRule.kind, name: 'Different title, same restriction', reason: 'Same action', target: existingRule.target }, 422, 'guard_draft_duplicate', /equivalent guard/],
    ] as const) {
      output = { guard };
      const response = await f.generate({ description });
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.json().code, code);
      assert.match(response.json().detail, expected);
      assert.doesNotMatch(response.body, /foreign-orders|FOREIGN_RULE_CANARY/);
    }
    assert.deepEqual(await f.store.settings(f.business.id), before);
  } finally { await f.app.close(); }
});

test('guard and skill drafting share the concurrency gate; changed catalog targets invalidate pending drafts', { timeout: 5000 }, async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ async generate() { entered(); await resume; return { guard: f.draft }; } });
  try {
    const before = await f.store.settings(f.business.id);
    const pending = Promise.resolve(f.generate({ description }));
    await started;
    const skill = await f.app.inject({ method: 'POST', url: `/api/v1/skills/draft?businessId=${f.business.id}`, headers, payload: { description } });
    assert.equal(skill.statusCode, 429);
    assert.equal(f.skillCalls(), 0);
    const target = (await f.store.integrationStore.get(f.business.id, 'orders'))!;
    await f.store.integrationStore.change(f.business.id, 'orders', target.version, 'test', 'integration.disabled', state => ({ ...state, enabled: false }));
    release();
    assert.equal((await pending).statusCode, 409);
    assert.deepEqual(await f.store.settings(f.business.id), before);
  } finally { release(); await f.app.close(); }
});

test('external guard drafts require both the integration and one reviewed write operation', async () => {
  let target: { tool: string; integrationId?: string; operationKey?: string };
  const f = await fixture({ async generate() { return { guard: { ...f.draft, target } }; } });
  try {
    const before = await f.store.settings(f.business.id);
    for (target of [{ tool: 'external_action' }, { tool: 'external_action', integrationId: 'orders' }, { tool: 'external_action', operationKey: f.draft.target.operationKey }]) {
      const response = await f.generate({ description: 'Deny all external actions for the workspace.' });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().code, 'guard_draft_target');
      assert.match(response.json().detail, /one reviewed external write operation/);
    }
    assert.deepEqual(await f.store.settings(f.business.id), before);
  } finally { await f.app.close(); }
});

test('guard draft context and rule-count limits return their codes before model work', async () => {
  let calls = 0;
  const f = await fixture({ async generate() { calls++; return { guard: null }; } });
  const rules = Array.from({ length: 30 }, () => ({ ...existingRule, id: randomUUID(), name: '界'.repeat(100), reason: '界'.repeat(240) }));
  try {
    for (const [count, input, code] of [[29, '界'.repeat(6_000), 'guard_draft_context'], [30, description, 'guard_draft_limit']] as const) {
      const { version } = await f.store.settings(f.business.id);
      const saved = await f.app.inject({ method: 'PUT', url: f.url, headers, payload: { version, rules: rules.slice(0, count) } });
      assert.equal(saved.statusCode, 200, saved.body);
      const response = await f.generate({ description: input });
      assert.equal(response.statusCode, 422, response.body);
      assert.equal(response.json().code, code);
    }
    assert.equal(calls, 0);
  } finally { await f.app.close(); }
});

test('guard drafting without a configured model reports capability and returns 503', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ url: f.url, headers })).json().canGenerate, false);
    assert.equal((await f.generate({ description })).statusCode, 503);
  } finally { await f.app.close(); }
});
