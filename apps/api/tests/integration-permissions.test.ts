import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fingerprint, resolvePermission, type CatalogOperation, type IntegrationPolicy } from '../src/integrations/permissions.js';

const businessId = '11111111-1111-4111-8111-111111111111';
const manifestHash = 'a'.repeat(64);
const op = (operationKey: string, tags: string[], effect: CatalogOperation['effect'] = 'read'): CatalogOperation => {
  const definition = { operationKey, tags, effect };
  return { ...definition, operationHash: fingerprint(definition) };
};
const getStatus = op('GET /orders/{order_id}', ['Orders']);
const cancel = op('POST /orders/{order_id}/cancel', ['Orders', 'Billing'], 'write');
const removeCustomer = op('DELETE /customers/{customer_id}', ['Customers'], 'write');

const policy = (): IntegrationPolicy => ({
  integrationId: 'orders', businessId, enabled: true, manifestHash, policyRevision: 3, defaultMode: 'deny',
  groups: [{ id: 'orders', selector: { tag: 'Orders' }, mode: 'ask' }, { id: 'billing', selector: { tag: 'Billing' }, mode: 'ask' }],
  operations: [
    { operationKey: getStatus.operationKey, enabled: true, reviewedOperationHash: getStatus.operationHash, mode: 'auto' },
    { operationKey: cancel.operationKey, enabled: true, reviewedOperationHash: cancel.operationHash, mode: 'inherit' },
    { operationKey: removeCustomer.operationKey, enabled: false, reviewedOperationHash: null, mode: 'deny' },
  ],
});
const resolve = (operation: CatalogOperation, raw: unknown = policy(), overrides: Partial<{ businessId: string; integrationId: string; manifestHash: string }> = {}) =>
  resolvePermission({ businessId, integrationId: 'orders', manifestHash, operation, ...overrides }, raw);

test('illustrative TODO config: status auto, cancel inherits ask from Orders, customer delete unavailable', () => {
  assert.deepEqual(resolve(getStatus), { mode: 'auto', source: 'operation', matchedRuleIds: [getStatus.operationKey], policyRevision: 3, reasonCode: 'operation_rule' });
  assert.deepEqual(resolve(cancel), { mode: 'ask', source: 'group', matchedRuleIds: ['billing', 'orders'], policyRevision: 3, reasonCode: 'group_conflict_strictest' });
  assert.equal(resolve(removeCustomer).reasonCode, 'operation_disabled');
});

test('new or changed operations stay denied even under integration/group auto', () => {
  const p = policy(); p.defaultMode = 'auto'; p.groups[0]!.mode = 'auto';
  const added = op('GET /orders', ['Orders']);
  assert.deepEqual([resolve(added, p).mode, resolve(added, p).reasonCode], ['deny', 'operation_disabled']);
  const changed = { ...getStatus, operationHash: fingerprint({ ...getStatus, tags: ['Orders', 'Admin'] }, 'operationHash') };
  assert.deepEqual([resolve(changed, p).mode, resolve(changed, p).reasonCode], ['deny', 'operation_unreviewed']);
  const unknownEffect = op('POST /orders/search', ['Orders'], 'unknown');
  p.operations.push({ operationKey: unknownEffect.operationKey, enabled: true, reviewedOperationHash: unknownEffect.operationHash, mode: 'auto' });
  assert.equal(resolve(unknownEffect, p).reasonCode, 'effect_unreviewed');
});

test('explicit endpoint rule beats group deny; group conflict picks deny > ask > auto regardless of order', () => {
  const p = policy(); p.groups[0]!.mode = 'deny';
  assert.equal(resolve(getStatus, p).mode, 'auto');
  assert.equal(resolve(cancel, p).mode, 'deny');
  p.groups.reverse();
  assert.deepEqual(resolve(cancel, p).matchedRuleIds, ['billing', 'orders']);
  assert.equal(resolve(cancel, p).mode, 'deny');
  const tagsReordered = { ...cancel, tags: ['Billing', 'Orders'] };
  assert.equal(resolve(tagsReordered, p).mode, 'deny');
});

test('inherit groups are skipped; no explicit group falls back to integration default; operationKeys selector works', () => {
  const p = policy(); p.groups = [{ id: 'orders', selector: { tag: 'Orders' }, mode: 'inherit' }];
  assert.deepEqual([resolve(cancel, p).mode, resolve(cancel, p).source], ['deny', 'integration']);
  p.defaultMode = 'ask';
  assert.equal(resolve(cancel, p).reasonCode, 'integration_default');
  p.groups.push({ id: 'cancel-only', selector: { operationKeys: [cancel.operationKey] }, mode: 'auto' });
  assert.deepEqual([resolve(cancel, p).mode, resolve(cancel, p).matchedRuleIds], ['auto', ['cancel-only']]);
});

test('fail closed: invalid policy, foreign business/integration, disabled integration, manifest drift', () => {
  for (const raw of [undefined, null, {}, { ...policy(), defaultMode: 'inherit' }, { ...policy(), extra: true }, { ...policy(), groups: [...policy().groups, policy().groups[0]] }]) {
    assert.deepEqual(resolvePermission({ businessId, integrationId: 'orders', manifestHash, operation: getStatus }, raw), { mode: 'deny', source: 'guard', matchedRuleIds: [], policyRevision: null, reasonCode: 'policy_invalid' });
  }
  assert.equal(resolve(getStatus, policy(), { businessId: '22222222-2222-4222-8222-222222222222' }).reasonCode, 'business_mismatch');
  // Same operationKey in another integration does not share its policy.
  assert.equal(resolve(getStatus, policy(), { integrationId: 'crm' }).reasonCode, 'integration_mismatch');
  assert.equal(resolve(getStatus, { ...policy(), enabled: false }).reasonCode, 'integration_disabled');
  assert.equal(resolve(getStatus, policy(), { manifestHash: 'b'.repeat(64) }).reasonCode, 'manifest_mismatch');
});

test('fingerprint ignores key order and formatting, excludes its own hash field, but sees real changes', () => {
  assert.equal(fingerprint({ b: 1, a: { d: [1, 2], c: 'x' } }), fingerprint(JSON.parse('{ "a": {"c":"x", "d":[1,2]},\n "b": 1 }')));
  assert.equal(fingerprint({ a: 1, manifestHash: 'x' }, 'manifestHash'), fingerprint({ a: 1, manifestHash: 'y' }, 'manifestHash'));
  assert.notEqual(fingerprint({ a: { d: [1, 2] } }), fingerprint({ a: { d: [2, 1] } }));
  assert.equal(fingerprint({'2':'two','10':'ten'}),createHash('sha256').update('{"10":"ten","2":"two"}').digest('hex'));
  assert.equal(fingerprint({small:1e-7}),createHash('sha256').update('{"small":1e-7}').digest('hex'));
  assert.equal(fingerprint({large:1e20,zero:-0}),createHash('sha256').update('{"large":100000000000000000000,"zero":0}').digest('hex'));
  for(const number of [NaN,Infinity]) assert.throws(()=>fingerprint({number}),/finite/);
});
