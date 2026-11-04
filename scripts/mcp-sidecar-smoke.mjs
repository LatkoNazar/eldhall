// End-to-end smoke for the OpenAPI → MCP sidecar against a running support API (synthetic data only).
//
//   node scripts/mcp-sidecar-smoke.mjs prepare --out <config.json> --url <sidecar MCP URL> [--loopback]
//     Writes a support config with one smoke business and the reviewed examples/orders catalog.
//   node scripts/mcp-sidecar-smoke.mjs run
//     Env: SMOKE_API_URL, OPERATOR_TOKEN, ORDERS_CONTROL_URL, ORDERS_TEST_CONTROL_TOKEN.
//     chat → DSH → call_business_tool → sidecar → mock Orders API → reply; then ask → approve → execute.
//
// The API must run with a model that calls the business tool (CI uses deploy/smoke/fake-llm.mjs). Tokens are read
// from the environment and never printed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const BUSINESS = { id: '50000000-0000-4000-8000-000000000001', slug: 'orders-smoke', name: 'Orders Smoke', currency: 'UAH',
  policy: { refundLimitCents: 10000, duplicateWindowMinutes: 10, enabledTools: ['escalate_to_human'] } };
const orders = new URL('../examples/orders/', import.meta.url);
const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };

async function prepare() {
  const out = arg('--out'); const url = arg('--url');
  if (!out || !url) throw new Error('prepare needs --out and --url');
  const manifest = JSON.parse(await readFile(new URL('manifest.json', orders), 'utf8'));
  const policy = { ...JSON.parse(await readFile(new URL('policy.json', orders), 'utf8')), businessId: BUSINESS.id };
  const upstreamUrl = new URL(arg('--upstream-url') ?? 'http://orders-mock:8090').href.replace(/\/+$/, '');
  const upstreamTargetFingerprint = createHash('sha256').update(JSON.stringify({ baseUrl: upstreamUrl, principalId: 'default' })).digest('hex');
  const catalog = { businessId: BUSINESS.id, url, credentialEnv: 'MCP_SERVICE_TOKEN', connectionRevision: '1', upstreamTargetFingerprint,
    allowInsecureLoopback: process.argv.includes('--loopback'), timeoutMs: 8000, manifest, policy };
  await writeFile(out, JSON.stringify({ businesses: [BUSINESS], catalogs: [catalog] }, null, 2));
  console.log(`smoke config written: business ${BUSINESS.id}, catalog ${manifest.integrationId}`);
}

function env(name) { const value = process.env[name]; if (!value) throw new Error(`Set ${name}`); return value; }

async function run() {
  const api = env('SMOKE_API_URL').replace(/\/$/, ''); const operator = env('OPERATOR_TOKEN');
  const control = env('ORDERS_CONTROL_URL').replace(/\/$/, ''); const controlToken = env('ORDERS_TEST_CONTROL_TOKEN');
  const call = async (method, path, { body, operatorAuth = false, session } = {}) => {
    const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(operatorAuth ? { authorization: `Bearer ${operator}` } : {}), ...(session ? { 'x-customer-session': session } : {}) };
    const response = await fetch(api + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const order = async orderId => (await fetch(`${control}/__test/orders/${orderId}`, { headers: { 'x-test-control': controlToken } })).json();
  const upstream = async orderId => (await order(orderId)).status;

  // A deployment artifact never activates its own tools. Review exact hashes and set permissions through
  // the same operator endpoints as the UI; the worker observes DB changes without a restart.
  const integrationPath = `/api/v1/integrations/orders`;
  const scoped = suffix => `${integrationPath}${suffix}?businessId=${BUSINESS.id}`;
  const readPolicy = async () => {
    const response = await call('GET', scoped('/policy'), { operatorAuth: true });
    assert.equal(response.status, 200, 'read integration policy');
    return response.json;
  };
  const edit = async (suffix, body, method = 'POST') => {
    const current = await readPolicy();
    const response = await call(method, scoped(suffix), { operatorAuth: true, body: { version: current.integration.version, ...body } });
    assert.equal(response.status, 200, `${suffix}: ${JSON.stringify(response.json)}`);
    return response.json;
  };
  const catalog = await call('GET', scoped('/operations'), { operatorAuth: true });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.json.integration.enabled, false, 'fresh integration starts disabled');
  assert.ok(catalog.json.operations.every(op => !op.enabled && !op.reviewedOperationHash), 'imported operations start unreviewed');
  assert.equal((await call('GET', scoped('/policy'))).status, 401, 'operator policy cannot be read by anonymous clients');
  const initial = await readPolicy();
  await edit('/policy', { defaultMode: 'deny', groups: [{ id: 'orders', selector: { tag: 'Orders' }, mode: 'ask' }],
    operations: [{ operationKey: 'GET /orders/{order_id}', mode: 'auto' }, { operationKey: 'POST /orders/{order_id}/cancel', mode: 'inherit' }] }, 'PATCH');
  assert.equal((await call('PATCH', scoped('/policy'), { operatorAuth: true, body: { version: initial.integration.version, defaultMode: 'auto' } })).status, 409, 'stale policy edit rejected');
  await edit('/review', { manifestHash: catalog.json.integration.loadedManifestHash,
    operations: catalog.json.operations.filter(op => op.effect !== 'unknown').map(op => ({ operationKey: op.operationKey, operationHash: op.operationHash, enabled: true })) });
  const reviewed = await readPolicy();
  await edit('/activate', { manifestHash: reviewed.integration.loadedManifestHash, connectionRevision: reviewed.integration.connectionRevision });
  console.log('operator activation: ok (disabled import, exact review, policy CAS and live sidecar verification)');

  // Customers are created through the operator API; the mock upstream then owns its orders under those ids
  // (the Eldhall → upstream id mapping is S1-3).
  const customer = async (name, email) => {
    const created = await call('POST', '/api/v1/customers', { operatorAuth: true, body: { businessId: BUSINESS.id, name, email, plan: 'Smoke' } });
    assert.equal(created.status, 201, `create customer: ${JSON.stringify(created.json)}`);
    return { id: created.json.customer.id, session: created.json.sessionToken };
  };
  const olena = await customer('Olena Smoke', 'olena.smoke@example.test');
  const taras = await customer('Taras Smoke', 'taras.smoke@example.test');
  const owners = await fetch(`${control}/__test/owners`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-control': controlToken }, body: JSON.stringify({ olena: olena.id, taras: taras.id }) });
  assert.equal(owners.status, 200, 'assign upstream owners');

  // On a wrong reply, show which model ran and why (runs[].error is redacted by the API) instead of guessing.
  const explain = async (caseId, reply) => {
    const runs = (await call('GET', `/api/v1/cases/${caseId}`, { operatorAuth: true })).json?.runs ?? [];
    return `${reply}\nruns: ${JSON.stringify(runs.map(({ provider, model, status, toolCalls, error }) => ({ provider, model, status, toolCalls, error })))}`;
  };
  const turn = async (who, text) => {
    const opened = await call('POST', '/api/v1/chat/cases', { session: who.session });
    assert.equal(opened.status, 201);
    const sent = await call('POST', `/api/v1/chat/cases/${opened.json.id}/messages`, { session: who.session, body: { body: text } });
    assert.ok([200, 202].includes(sent.status), `send message: ${sent.status} ${JSON.stringify(sent.json)}`);
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await call('GET', `/api/v1/chat/cases/${opened.json.id}`, { session: who.session });
      const reply = state.json.messages.filter(message => message.role === 'assistant').at(-1);
      if (reply && !state.json.activeRun) return { caseId: opened.json.id, reply: reply.body };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`no reply for "${text}"`);
  };

  // 1. auto read: the reply carries the status the sidecar read from the upstream for this customer.
  const status = await turn(olena, 'Який статус замовлення ORD-1002?');
  assert.match(status.reply, /Статус замовлення: shipped\./, await explain(status.caseId, status.reply));
  const detail = (await call('GET', `/api/v1/cases/${status.caseId}`, { operatorAuth: true })).json;
  assert.ok(detail.runs.some(run => run.status === 'ok' && run.toolCalls.includes('call_business_tool')), 'model run used call_business_tool');
  console.log('auto read: ok (chat → DSH → sidecar → upstream → reply)');

  // 2. another customer of the same business cannot read Olena's order.
  const foreignBefore = (await order('ORD-1001')).foreignReads;
  const foreign = await turn(taras, 'Який статус замовлення ORD-1001?');
  // The scripted model got a business-tool error, and the upstream itself saw and refused Taras's read of Olena's order.
  assert.equal(foreign.reply, 'Не вдалося отримати дані замовлення.', await explain(foreign.caseId, foreign.reply));
  assert.equal((await order('ORD-1001')).foreignReads, foreignBefore + 1, 'the upstream refused exactly one foreign read');
  const foreignAudit = (await call('GET', `/api/v1/cases/${foreign.caseId}`, { operatorAuth: true })).json;
  assert.ok(foreignAudit.runs.some(run => run.toolCalls.includes('call_business_tool')), 'the foreign read was attempted through the sidecar');
  console.log('ownership: ok (foreign order not readable)');

  // 3. ask: proposal only; approve does nothing upstream; execute does it once.
  const ask = await turn(olena, 'Скасуйте, будь ласка, замовлення ORD-1001');
  assert.match(ask.reply, /підготував запит «Cancel order»/, await explain(ask.caseId, ask.reply));
  const proposal = (await call('GET', `/api/v1/cases/${ask.caseId}`, { operatorAuth: true })).json.proposals.find(row => row.tool === 'external_action');
  assert.equal(proposal?.status, 'pending');
  assert.equal(await upstream('ORD-1001'), 'paid');
  assert.equal((await call('POST', `/api/v1/proposals/${proposal.id}/approve`, { operatorAuth: true, body: { argsHash: proposal.argsHash } })).status, 200);
  assert.equal(await upstream('ORD-1001'), 'paid', 'approve alone must not change the upstream');
  const executed = await call('POST', `/api/v1/proposals/${proposal.id}/execute`, { operatorAuth: true, body: { argsHash: proposal.argsHash } });
  assert.equal(executed.status, 200, JSON.stringify(executed.json));
  assert.equal(executed.json.proposal.status, 'executed');
  assert.equal(await upstream('ORD-1001'), 'cancelled');
  assert.equal((await order('ORD-1001')).writes, 1, 'exactly one cancel reached the upstream');
  assert.equal((await order('ORD-1001')).cancelRequests, 1, 'exactly one cancel request arrived (not only one effect)');
  assert.equal((await call('POST', `/api/v1/proposals/${proposal.id}/execute`, { operatorAuth: true, body: { argsHash: proposal.argsHash } })).status, 409, 'second execute refused');
  assert.equal((await order('ORD-1001')).cancelRequests, 1, 'the refused second execute sent nothing upstream');
  const messages = (await call('GET', `/api/v1/chat/cases/${ask.caseId}`, { session: olena.session })).json.messages;
  assert.equal(messages.at(-1).body, 'Дію «Cancel order» виконано (статус: cancelled).');
  console.log('ask → approve → execute: ok (one upstream effect, second execute refused)');

  // 4. The same guarded cancellation runs in explicit auto mode via the same durable ledger.
  await edit('/policy', { operations: [{ operationKey: 'POST /orders/{order_id}/cancel', mode: 'auto' }] }, 'PATCH');
  const automatic = await turn(olena, 'Скасуйте, будь ласка, замовлення ORD-1003');
  const autoDetail = (await call('GET', `/api/v1/cases/${automatic.caseId}`, { operatorAuth: true })).json;
  const autoProposal = autoDetail.proposals.find(row => row.tool === 'external_action');
  assert.equal(autoProposal?.status, 'executed', await explain(automatic.caseId, automatic.reply));
  assert.equal(await upstream('ORD-1003'), 'cancelled');
  assert.equal((await order('ORD-1003')).writes, 1);
  assert.ok(autoDetail.audit.some(event => event.data?.origin === 'policy_auto'), 'automatic origin is recorded honestly');
  console.log('auto write: ok (same execution ledger, one effect, policy_auto audit)');

  // 5. Guards apply in auto mode, and deny blocks a direct facade call before the upstream mutation.
  const shippedBefore = (await order('ORD-1002')).cancelRequests;
  await turn(olena, 'Скасуйте, будь ласка, замовлення ORD-1002');
  assert.equal(await upstream('ORD-1002'), 'shipped', 'shipped order guard remains enforced');
  assert.equal((await order('ORD-1002')).writes, 0);
  await edit('/policy', { operations: [{ operationKey: 'POST /orders/{order_id}/cancel', mode: 'deny' }] }, 'PATCH');
  await turn(olena, 'Скасуйте, будь ласка, замовлення ORD-1002');
  assert.equal((await order('ORD-1002')).cancelRequests, shippedBefore, 'guarded and denied operations sent no cancel request');
  console.log('guard and deny: ok (no forbidden mutation reached upstream)');
  await edit('/disable', { draining: true });
  assert.equal((await readPolicy()).integration.draining, true);
  console.log('draining: ok (new calls disabled)');
  console.log('MCP sidecar smoke OK');
}

const command = process.argv[2];
await (command === 'prepare' ? prepare() : command === 'run' ? run() : Promise.reject(new Error('usage: prepare | run')));
