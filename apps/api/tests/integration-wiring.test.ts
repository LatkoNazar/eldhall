import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type pg from 'pg';
import { settingsFrom } from '../src/core/config.js';
import { createSupportIntegrations } from '../src/integrations/catalog.js';
import { loadSupportConfig, supportConfigSchema } from '../src/integrations/config.js';
import type { Manifest } from '../src/integrations/manifest.js';
import { combineIntegrations, IntegrationError, type BusinessIntegrations } from '../src/integrations/mcp.js';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { fingerprint, type IntegrationPolicy } from '../src/integrations/permissions.js';
import { createSupport } from '../src/modules/support/factory.js';

const orders = new URL('../../../examples/orders/', import.meta.url);
const fixture = async <T>(name: string) => JSON.parse(await readFile(new URL(name, orders), 'utf8')) as T;
const A = '10000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';
// Port 9 (discard): anything that reaches the network surfaces as `unavailable`, never `denied`.
const catalog = (manifest: Manifest, policy: IntegrationPolicy, businessId = A) => ({ businessId, url: 'http://127.0.0.1:9/mcp', credentialEnv: 'WIRING_TEST_SIDECAR_TOKEN', allowInsecureLoopback: true, manifest, policy: { ...policy, businessId } });
const legacy = (businessId: string, id: string) => ({ id, businessId, url: 'https://mcp.example.com/mcp', tools: [{ name: 'lookup_loyalty', description: 'Read loyalty points', access: 'read',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, scopeBindings: { businessId: 'business_id', customerId: 'customer_id' }, outputFields: ['points'] }] });
const denied = (pattern: RegExp) => (error: unknown) => error instanceof IntegrationError && error.code === 'denied' && pattern.test(error.message);

test('config: a catalog embeds its reviewed manifest and policy; mismatches are refused at startup', async () => {
  const manifest = await fixture<Manifest>('manifest.json');
  const policy = await fixture<IntegrationPolicy>('policy.json');
  assert.equal(supportConfigSchema.parse({ catalogs: [catalog(manifest, policy)] }).catalogs[0]!.timeoutMs, 5000);
  const issues = (raw: unknown) => { const parsed = supportConfigSchema.safeParse(raw); return parsed.success ? [] : parsed.error.issues.map(issue => issue.message); };
  assert.ok(issues({ catalogs: [{ ...catalog(manifest, policy), policy: { ...policy, businessId: B } }] }).includes('Catalog policy belongs to another business'));
  assert.ok(issues({ catalogs: [{ ...catalog(manifest, policy), policy: { ...policy, businessId: A, integrationId: 'crm' } }] }).includes('Catalog policy is for another integration'));
  assert.ok(issues({ catalogs: [{ ...catalog(manifest, policy), policy: { ...policy, businessId: A, manifestHash: 'b'.repeat(64) } }] }).includes('Catalog policy was reviewed against another manifest'));
  const tampered = structuredClone(manifest); tampered.operations[0]!.outputFields.push('internal_note');
  assert.ok(issues({ catalogs: [catalog(tampered, policy)] }).some(message => message.includes('operationHash')));
  assert.ok(issues({ catalogs: [catalog(manifest, policy)], integrations: [legacy(A, 'orders')] }).includes('Duplicate integration id within a business'));
  assert.deepEqual(issues({ catalogs: [catalog(manifest, policy)], integrations: [legacy(B, 'orders')] }), []); // same id, another business: fine
  for (const field of ['credential', 'token', 'secret']) assert.ok(issues({ catalogs: [{ ...catalog(manifest, policy), [field]: 'x' }] }).length > 0, field);
});

test('routing: each business sees only its integrations; calls go to the owner by integration id', async () => {
  const manifest = await fixture<Manifest>('manifest.json');
  const policy = await fixture<IntegrationPolicy>('policy.json');
  const config = supportConfigSchema.parse({ catalogs: [catalog(manifest, policy)], integrations: [legacy(A, 'loyalty'), legacy(B, 'loyalty_b')] });
  assert.throws(() => createSupportIntegrations(config, {}), /WIRING_TEST_SIDECAR_TOKEN/);
  const integrations = createSupportIntegrations(config, { WIRING_TEST_SIDECAR_TOKEN: 'x'.repeat(20) });
  const context = (businessId: string) => ({ businessId, customerId: 'customer-1', assertActive: async () => undefined });
  const a = integrations.forContext(context(A));
  assert.deepEqual(a.tools.map(tool => `${tool.integrationId}/${tool.name}`).sort(), ['loyalty/lookup_loyalty', 'orders/cancel_order', 'orders/get_order_status']);
  const b = integrations.forContext(context(B));
  assert.deepEqual(b.tools.map(tool => `${tool.integrationId}/${tool.name}`), ['loyalty_b/lookup_loyalty']);
  // Routed to the catalog: `ask` without the harness ledger fails closed before any network call.
  await assert.rejects(a.callTool('orders', 'cancel_order', { order_id: 'ORD-1001' }), denied(/ledger/));
  await assert.rejects(b.callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), denied(/allowlisted/));
  await assert.rejects(a.callTool('crm', 'get_order_status', { order_id: 'ORD-1001' }), denied(/allowlisted/));
  // A tool name of one integration cannot be invoked under another integration's id.
  await assert.rejects(a.callTool('loyalty', 'cancel_order', { order_id: 'ORD-1001' }), denied(/allowlisted/));
  assert.deepEqual(await a.executeAction!({ integrationId: 'orders' }, 'p1'), { status: 'failed', reasonCode: 'invalid_snapshot' });
  assert.deepEqual(await b.executeAction!({ integrationId: 'orders' }, 'p1'), { status: 'failed', reasonCode: 'integration_unavailable' });
  assert.deepEqual(await a.executeAction!({ integrationId: 'loyalty' }, 'p1'), { status: 'failed', reasonCode: 'integration_unavailable' }); // read-only MCP never executes actions
  await assert.rejects(b.callTool('loyalty', 'lookup_loyalty', {}), denied(/allowlisted/)); // business A's integration id from business B
});

test('factory: SUPPORT_CONFIG_FILE with a catalog loads at startup and refuses a missing credential', async () => {
  const manifest = await fixture<Manifest>('manifest.json');
  const policy = await fixture<IntegrationPolicy>('policy.json');
  const dir = await mkdtemp(join(tmpdir(), 'catalog-config-'));
  try {
    const file = join(dir, 'support.json');
    const business = { id: A, slug: 'orders-shop', name: 'Orders Shop', currency: 'UAH', policy: { refundLimitCents: 10000, duplicateWindowMinutes: 10, enabledTools: ['escalate_to_human'] } };
    await writeFile(file, JSON.stringify({ businesses: [business], catalogs: [catalog(manifest, policy)] }));
    assert.equal((await loadSupportConfig(file)).catalogs[0]!.manifest.manifestHash, manifest.manifestHash);
    const settings = settingsFrom({ SUPPORT_CONFIG_FILE: file, DEMO_RESET_ENABLED: 'false' });
    delete process.env.WIRING_TEST_SIDECAR_TOKEN;
    await assert.rejects(createSupport(settings, {} as pg.Pool), /Missing MCP sidecar credential environment reference: WIRING_TEST_SIDECAR_TOKEN/);
    process.env.WIRING_TEST_SIDECAR_TOKEN = 'x'.repeat(20);
    try { assert.ok(await createSupport(settings, {} as pg.Pool)); } finally { delete process.env.WIRING_TEST_SIDECAR_TOKEN; }
    // A manifest edited after review never loads.
    const edited = structuredClone(manifest); edited.generatorVersion = 'edited'; edited.manifestHash = fingerprint(edited, 'manifestHash');
    await writeFile(file, JSON.stringify({ businesses: [business], catalogs: [catalog(edited, policy)] }));
    await assert.rejects(loadSupportConfig(file), /reviewed against another manifest/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('combineIntegrations: only the owning part is created and called, per business and integration id', async () => {
  const calls: string[] = [];
  const part = (label: string, tools: string[]): BusinessIntegrations => ({ forContext(ctx) {
    calls.push(`${label}.forContext(${ctx.businessId})`);
    return {
      tools: tools.map(name => ({ integrationId: label, name, description: name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } })),
      callTool: async (integrationId, name) => { calls.push(`${label}.callTool(${integrationId}/${name})`); return label; },
      executeAction: async (args) => { calls.push(`${label}.executeAction(${String(args.integrationId)})`); return { status: 'executed', data: label }; },
    };
  } });
  // Same tool name in two integrations of one business, plus another business that must never be touched.
  const combined = combineIntegrations([
    { owns: [[A, 'legacy']], integrations: part('legacy', ['lookup']) },
    { owns: [[A, 'orders']], integrations: part('orders', ['lookup']) },
    { owns: [[B, 'other']], integrations: part('other', ['lookup']) },
  ]);
  const scoped = combined.forContext({ businessId: A, customerId: 'c', assertActive: async () => undefined });
  assert.deepEqual(calls.splice(0), ['legacy.forContext(' + A + ')', 'orders.forContext(' + A + ')']);
  assert.equal(await scoped.callTool('orders', 'lookup', {}), 'orders');
  assert.equal(await scoped.callTool('legacy', 'lookup', {}), 'legacy');
  assert.deepEqual(await scoped.executeAction!({ integrationId: 'orders' }, 'p'), { status: 'executed', data: 'orders' });
  assert.deepEqual(calls.splice(0), ['orders.callTool(orders/lookup)', 'legacy.callTool(legacy/lookup)', 'orders.executeAction(orders)']);
  for (const integrationId of ['other', 'missing', undefined, 'undefined']) {
    await assert.rejects(scoped.callTool(integrationId as string, 'lookup', {}), denied(/allowlisted/));
    assert.deepEqual(await scoped.executeAction!({ integrationId }, 'p'), { status: 'failed', reasonCode: 'integration_unavailable' });
  }
  assert.deepEqual(calls, []); // nothing reached any part, least of all business B's
  assert.deepEqual(combined.forContext({ businessId: '30000000-0000-4000-8000-000000000003', customerId: 'c', assertActive: async () => undefined }).tools, []);
});

test('config: catalog URLs follow the MCP URL rule; bootstrap refuses a catalog for an unknown business', async () => {
  const manifest = await fixture<Manifest>('manifest.json');
  const policy = await fixture<IntegrationPolicy>('policy.json');
  for (const url of ['http://sidecar.internal/mcp', 'https://user:pass@sidecar.example/mcp', 'https://sidecar.example/mcp?token=x', 'http://127.0.0.1:9/mcp']) {
    const entry = { ...catalog(manifest, policy), url, allowInsecureLoopback: false };
    assert.equal(supportConfigSchema.safeParse({ catalogs: [entry] }).success, false, url);
  }
  assert.equal(supportConfigSchema.safeParse({ catalogs: [{ ...catalog(manifest, policy), url: 'https://sidecar.example/mcp', allowInsecureLoopback: false }] }).success, true);
  const config = supportConfigSchema.parse({ catalogs: [catalog(manifest, policy)] });
  await assert.rejects(bootstrapSupportConfig(new MemorySupportStore(), config), /unknown business/);
});

test('internal sidecar origin: plain HTTP only to a service name the deployment allowlisted exactly', async () => {
  const manifest = await fixture<Manifest>('manifest.json');
  const policy = await fixture<IntegrationPolicy>('policy.json');
  const entry = (url: string) => ({ ...catalog(manifest, policy), url, allowInsecureLoopback: false });
  // Config shape: a single-label service name with an explicit port, never a public or IP host.
  assert.equal(supportConfigSchema.safeParse({ catalogs: [entry('http://mcp-openapi:8000/mcp')] }).success, true);
  for (const url of ['http://mcp.example.com:8000/mcp', 'http://10.0.0.5:8000/mcp', 'http://mcp-openapi/mcp', 'http://mcp_openapi:8000/mcp', 'http://localhost:8000/mcp']) {
    assert.equal(supportConfigSchema.safeParse({ catalogs: [entry(url)] }).success, false, url);
  }
  const config = supportConfigSchema.parse({ catalogs: [entry('http://mcp-openapi:8000/mcp')] });
  const env = { WIRING_TEST_SIDECAR_TOKEN: 'x'.repeat(20) };
  // Startup: the deployment must name that exact origin.
  assert.throws(() => createSupportIntegrations(config, env), /MCP_INTERNAL_HTTP_ORIGINS/);
  assert.throws(() => createSupportIntegrations(config, { ...env, MCP_INTERNAL_HTTP_ORIGINS: '["http://other:8000"]' }), /MCP_INTERNAL_HTTP_ORIGINS/);
  for (const bad of ['http://mcp-openapi:8000', '["https://mcp-openapi:8000"]', '["http://localhost:8000"]', '["http://mcp.example.com:8000"]', '["http://mcp-openapi:8000/mcp"]', '[1]']) {
    assert.throws(() => createSupportIntegrations(config, { ...env, MCP_INTERNAL_HTTP_ORIGINS: bad }), /must be a JSON array of http:\/\/<service>:<port> origins/, bad);
  }
  const scoped = createSupportIntegrations(config, { ...env, MCP_INTERNAL_HTTP_ORIGINS: '["http://mcp-openapi:8000"]' })
    .forContext({ businessId: A, customerId: 'c', assertActive: async () => undefined });
  assert.deepEqual(scoped.tools.map(tool => tool.name), ['get_order_status', 'cancel_order']);
  // The allowlist never relaxes legacy MCP integrations, which stay HTTPS-only.
  assert.equal(supportConfigSchema.safeParse({ integrations: [{ ...legacy(A, 'loyalty'), url: 'http://mcp-openapi:8000/mcp' }] }).success, false);
});
