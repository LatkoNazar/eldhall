// Real stack: mock Orders upstream (node) <- Python FastMCP sidecar (uv) <- TS catalog integration.
// Run: npm run test:mcp-openapi  (needs uv; apps/mcp-openapi dependencies resolve on first run).
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createCatalogIntegration } from '../src/integrations/catalog.js';
import type { Manifest } from '../src/integrations/manifest.js';
import { IntegrationError } from '../src/integrations/mcp.js';
import { fingerprint } from '../src/integrations/permissions.js';
// @ts-expect-error plain .mjs fixture without type declarations
import { createOrdersApi } from '../../../examples/orders/mock-api.mjs';

const orders = new URL('../../../examples/orders/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', orders), 'utf8')) as Manifest;
const policy = JSON.parse(await readFile(new URL('policy.json', orders), 'utf8')) as { businessId: string; operations: { reviewedOperationHash: string | null }[] };
const serviceToken = 'local-sidecar-service-token';
const context = { businessId: policy.businessId, customerId: 'cust-olena', assertActive: async () => undefined };
const code = (expected: IntegrationError['code'], message?: RegExp) => (error: unknown) => error instanceof IntegrationError && error.code === expected && (!message || message.test(error.message));

let upstream: Server;
let sidecar: ChildProcess;
let sidecarUrl = '';

const freePort = () => new Promise<number>(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });

before(async () => {
  upstream = createOrdersApi({ token: 'upstream-token' }) as Server;
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  sidecarUrl = `http://127.0.0.1:${port}/mcp`;
  sidecar = spawn('uv', ['run', '--quiet', '--project', fileURLToPath(new URL('../../mcp-openapi/', import.meta.url)), 'support-mcp-server'], {
    env: { ...process.env, MANIFEST_PATH: fileURLToPath(new URL('manifest.json', orders)), UPSTREAM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, UPSTREAM_TOKEN: 'upstream-token', MCP_SERVICE_TOKEN: serviceToken, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32', // own process group, so the whole tree can be stopped
  });
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false);
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('sidecar did not become healthy');
});

after(async () => {
  // `uv run` leaves the Python child alive if only the wrapper is killed.
  if (sidecar?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(sidecar.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-sidecar.pid, 'SIGTERM');
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

const integration = (overrides: Partial<Parameters<typeof createCatalogIntegration>[0]> = {}) => createCatalogIntegration({
  businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, timeoutMs: 5000, manifest, policy, ...overrides,
}).forContext(context);

test('auto read: own order through sidecar, reviewed fields only; ask/deny not executable', async () => {
  const scoped = integration();
  assert.deepEqual(scoped.tools.map(tool => tool.name), ['get_order_status', 'cancel_order']);
  assert.deepEqual(await scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }),
    { order_id: 'ORD-1001', status: 'paid', total_cents: 49900, currency: 'UAH', tracking_url: null });
  await assert.rejects(scoped.callTool('orders', 'cancel_order', { order_id: 'ORD-1001' }), code('denied', /approval/));
  await assert.rejects(scoped.callTool('orders', 'delete_customer', {}), code('denied', /operation_disabled/));
  // Cancel was never dispatched upstream.
  assert.equal((await scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }) as { status: string }).status, 'paid');
});

test('foreign order and scope spoofing never reach another customer', async () => {
  const scoped = integration();
  await assert.rejects(scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-2001' }), code('unavailable'));
  await assert.rejects(scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-2001', eldhall: { customerId: 'cust-taras' } }), code('invalid_input'));
  await assert.rejects(scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-2001', customer_id: 'cust-taras' }), code('invalid_input'));
  const taras = createCatalogIntegration({ businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, manifest, policy })
    .forContext({ ...context, customerId: 'cust-taras' });
  assert.equal((await taras.callTool('orders', 'get_order_status', { order_id: 'ORD-2001' }) as { order_id: string }).order_id, 'ORD-2001');
});

test('unreviewed tool, catalog drift and wrong service credential fail closed', async () => {
  const unreviewed = structuredClone(policy); unreviewed.operations[0]!.reviewedOperationHash = 'f'.repeat(64);
  await assert.rejects(integration({ policy: unreviewed }).callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), code('denied', /operation_unreviewed/));
  // Backend reviewed a different manifest than the sidecar serves (same operations, new generator).
  const drifted = structuredClone(manifest); drifted.generatorVersion = 'support-mcp-openapi/9.9.9'; drifted.manifestHash = fingerprint(drifted, 'manifestHash');
  const driftedPolicy = { ...structuredClone(policy), manifestHash: drifted.manifestHash };
  await assert.rejects(integration({ manifest: drifted, policy: driftedPolicy }).callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), code('denied', /manifest does not match/));
  await assert.rejects(integration({ credential: 'wrong-service-token-value' }).callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), code('unavailable'));
});
