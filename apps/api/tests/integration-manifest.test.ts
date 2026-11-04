import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createCatalogIntegration } from '../src/integrations/catalog.js';
import { manifestSchema, type Manifest } from '../src/integrations/manifest.js';
import { IntegrationError } from '../src/integrations/mcp.js';
import { fingerprint, resolvePermission } from '../src/integrations/permissions.js';
// @ts-expect-error plain .mjs fixture without type declarations
import { createOrdersApi } from '../../../examples/orders/mock-api.mjs';

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../../../examples/orders/${name}`, import.meta.url), 'utf8')) as unknown;
const rehash = (manifest: Manifest): Manifest => {
  for (const op of manifest.operations) op.operationHash = fingerprint(op, 'operationHash');
  manifest.manifestHash = fingerprint(manifest, 'manifestHash');
  return manifest;
};
const issues = (raw: unknown) => {
  const parsed = manifestSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
};

test('Orders fixture: manifest verifies, spec hash matches, policy resolves read auto / cancel ask / delete denied', async () => {
  const manifest = manifestSchema.parse(await fixture('manifest.json'));
  assert.equal(manifest.specHash, fingerprint(await fixture('normalized.openapi.json')));
  const policy = await fixture('policy.json') as { businessId: string };
  const decide = (index: number) => {
    const op = manifest.operations[index]!;
    return resolvePermission({ businessId: policy.businessId, integrationId: manifest.integrationId, manifestHash: manifest.manifestHash, operation: op }, policy);
  };
  assert.deepEqual(manifest.operations.map(op => [op.toolName, op.effect]), [['get_order_status', 'read'], ['cancel_order', 'write'], ['delete_customer', 'unknown']]);
  assert.deepEqual([decide(0).mode, decide(1).mode, decide(1).matchedRuleIds, decide(2).reasonCode], ['auto', 'ask', ['orders'], 'operation_disabled']);
});

test('tampering or drift breaks the hashes; formatting does not', async () => {
  const raw = await fixture('manifest.json') as Manifest;
  const reversed = (value: unknown): unknown => Array.isArray(value) ? value.map(reversed)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value;
  assert.equal(manifestSchema.safeParse(JSON.parse(JSON.stringify(reversed(raw), null, 7))).success, true);
  const widened = structuredClone(raw); widened.operations[0]!.outputFields.push('internal_note');
  assert.ok(issues(widened).some(message => message.includes('operationHash')));
  const swapped = structuredClone(raw); swapped.operations[0]!.operationHash = swapped.operations[1]!.operationHash;
  assert.ok(issues(swapped).length > 0);
  const relabelled = rehash(structuredClone(raw)); relabelled.integrationId = 'crm';
  assert.deepEqual(issues(relabelled), ['manifestHash does not match canonical content']);
});

test('structural rules: key, mappings, scope isolation, path params, uniqueness, reconciliation', async () => {
  const base = await fixture('manifest.json') as Manifest;
  const broken = (edit: (m: Manifest) => void) => { const copy = structuredClone(base); edit(copy); return issues(rehash(copy)); };
  assert.deepEqual(issues(rehash(structuredClone(base))), []);
  assert.ok(broken(m => { m.operations[0]!.operationKey = 'GET /orders'; })[0]!.includes('operationKey must be'));
  assert.ok(broken(m => { delete m.operations[1]!.parameters.reason; })[0]!.includes('parameter mapping'));
  assert.ok(broken(m => {
    const op = m.operations[0]!;
    op.inputSchema.properties!.customer_id = { type: 'string' }; op.parameters.customer_id = 'query'; op.scope.customerId = { in: 'query', name: 'customer_id' };
  })[0]!.includes('scope fields'));
  assert.ok(broken(m => { m.operations[0]!.parameters.order_id = 'query'; })[0]!.includes('path template'));
  assert.ok(broken(m => { m.operations[0]!.inputSchema.required = []; })[0]!.includes('must be required'));
  assert.ok(broken(m => { m.operations[0]!.idempotency = { header: 'Idempotency-Key' }; })[0]!.includes('writes only'));
  assert.ok(broken(m => { m.operations[2]!.toolName = 'cancel_order'; }).includes('Duplicate toolName'));
  assert.ok(broken(m => { m.operations[1]!.reconciliation = { operationKey: 'GET /nope' }; })[0]!.includes('reconciliation'));
  // Model input can never be routed into a header.
  assert.ok(broken(m => { (m.operations[1]!.parameters as Record<string, string>).reason = 'header'; }).length > 0);
});

test('catalog integration fails closed before any network call', async () => {
  const manifest = await fixture('manifest.json');
  const policy = await fixture('policy.json') as { businessId: string; enabled: boolean; operations: { mode: string }[] };
  // Port 9 is discard: reaching the network would surface as `unavailable`, not `denied`/`invalid_input`.
  const make = (raw = policy) => createCatalogIntegration({ businessId: policy.businessId, url: 'http://127.0.0.1:9/mcp', credential: 'x'.repeat(20), allowInsecureLoopback: true, manifest, policy: raw });
  const context = { businessId: policy.businessId, customerId: 'cust-olena', assertActive: async () => undefined };
  const denied = (pattern: RegExp) => (error: unknown) => error instanceof IntegrationError && error.code === 'denied' && pattern.test(error.message);
  const scoped = make().forContext(context);
  assert.deepEqual(scoped.tools.map(tool => tool.name), ['get_order_status', 'cancel_order']);
  await assert.rejects(scoped.callTool('orders', 'cancel_order', { order_id: 'ORD-1001' }), denied(/ledger/));
  await assert.rejects(scoped.callTool('orders', 'delete_customer', {}), denied(/operation_disabled/));
  await assert.rejects(scoped.callTool('crm', 'get_order_status', { order_id: 'ORD-1001' }), denied(/allowlisted/));
  for (const input of [{ order_id: 'ORD-1001', eldhall: { customerId: 'cust-taras' } }, { order_id: 'ORD-1001', customer_id: 'cust-taras' }, { order_id: 'x'.repeat(51) }]) {
    await assert.rejects(scoped.callTool('orders', 'get_order_status', input), (error: unknown) => error instanceof IntegrationError && error.code === 'invalid_input');
  }
  const writeAuto = structuredClone(policy); writeAuto.operations[1]!.mode = 'auto';
  await assert.rejects(make(writeAuto).forContext(context).callTool('orders', 'cancel_order', { order_id: 'ORD-1001' }), denied(/ledger/));
  const foreign = make().forContext({ ...context, businessId: '20000000-0000-4000-8000-000000000002' });
  assert.deepEqual(foreign.tools, []);
  await assert.rejects(foreign.callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), denied(/allowlisted/));
  assert.deepEqual(make({ ...policy, enabled: false }).forContext(context).tools, []);
  assert.throws(() => make().forContext({ ...context, customerId: '' }), denied(/identity/));
  assert.throws(() => createCatalogIntegration({ businessId: policy.businessId, url: 'http://sidecar.internal/mcp', credential: 'x'.repeat(20), manifest, policy }), /HTTPS/);
});

test('mock Orders API: auth, ownership without probing, private fields, cancel guard and idempotent replay', async () => {
  const server = createOrdersApi({ token: 't' }) as import('node:http').Server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: 'Bearer t', 'x-customer-id': 'cust-olena', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return [res.status, await res.json().catch(() => null)] as const;
  };
  try {
    assert.equal((await call('GET', '/orders/ORD-1001', { authorization: 'Bearer wrong' }))[0], 401);
    const [status, order] = await call('GET', '/orders/ORD-1001');
    assert.equal(status, 200);
    assert.equal((order as Record<string, unknown>).internal_note, 'VIP, margin 12%'); // upstream leaks it; manifest outputFields must drop it
    assert.deepEqual(await call('GET', '/orders/ORD-2001'), await call('GET', '/orders/NOPE'));
    assert.equal((await call('POST', '/orders/ORD-1001/cancel'))[0], 400);
    const key = { 'idempotency-key': 'act-1' };
    const first = await call('POST', '/orders/ORD-1001/cancel', key, { reason: 'changed mind' });
    assert.deepEqual([first[0], (first[1] as { status: string }).status], [200, 'cancelled']);
    assert.deepEqual(await call('POST', '/orders/ORD-1001/cancel', key), first);
    assert.equal((await call('POST', '/orders/ORD-1001/cancel', { 'idempotency-key': 'act-2' }))[0], 409);
    assert.equal((await call('POST', '/orders/ORD-1002/cancel', key))[0], 422);
    assert.deepEqual((await call('POST', '/orders/ORD-1002/cancel', { 'idempotency-key': 'act-3' }))[1], { error: 'not_cancellable', status: 'shipped' });
    assert.equal((await call('POST', '/orders/ORD-2001/cancel', { 'idempotency-key': 'act-4' }))[0], 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
