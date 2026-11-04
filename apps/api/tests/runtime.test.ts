import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentContext, AgentDecision } from '../src/modules/agent/model.js';
import { seedData } from '../src/modules/support/seed.js';
import { DshSupportModel } from '../src/runtime/dsh-model.js';
import { childEnvironment, prepareProfile, SUPPORT_TOOLS } from '../src/runtime/profile.js';
import { classificationConfigSchema } from '../src/modules/agent/classification.js';

const finalDecision: AgentDecision = { intent: 'duplicate_charge', summary: 'A duplicate charge was found.', reasoning: 'Two matching captured charges.',
  sentiment: { label: 'frustrated', urgency: 'high' }, reply: 'I prepared a refund for specialist review.',
  action: { tool: 'refund_payment', args: { payment_id: '00000000-0000-4000-8000-000000000202', amount_cents: 49900 } } };

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  const data = seedData();
  const business = data.businesses[0]!;
  return { businessId: business.id, conversationId: 'runtime-fixture', runId: 'run-1', ownershipVersion: 1,
    assertActive: async () => undefined, business, customer: data.customers[0]!,
    payments: data.payments.filter(p => p.customerId === data.customers[0]!.id), history: [],
    message: 'You charged me twice!', allowedTools: business.policy.enabledTools,
    knowledge: [{ id: 'kb-1', title: 'Duplicate charges', content: 'Refund duplicate payments only after staff approval.', version: 1 }],
    skills: [{ id: 'skill-1', name: 'Calm support', content: 'Acknowledge frustration before asking a question.', revision: 1 }],
    searchKnowledge: async () => [{ id: 'kb-1', title: 'Duplicate charges', content: 'Refund duplicate payments only after staff approval.', version: 1 }], ...overrides };
}

type ModelRequest = { tools?: { function: { name: string; parameters?: Record<string, unknown> } }[]; messages?: unknown[] };
async function endpoint(script: { name: string; args: unknown }[], hold = false) {
  const requests: ModelRequest[] = [];
  let received!: () => void;
  const firstRequest = new Promise<void>(resolve => { received = resolve; });
  const server = createServer((req, res) => { void (async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest);
    received();
    if (hold) return;
    const operation = script[(requests.length - 1) % script.length]!;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const data = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: `chat-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'support-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    data({ role: 'assistant', content: '' });
    data({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.args) } }] });
    data({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
  })().catch(error => { res.writeHead(500); res.end(String(error)); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, requests, firstRequest, url: `http://127.0.0.1:${address.port}/v1` };
}
async function stop(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('actual installed DSH exposes only gateway tools, retrieves knowledge, submits a proposal and resumes its native session', { timeout: 60000 }, async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'support-runtime-test-'));
  const api = await endpoint([{ name: 'lookup_payments', args: { limit: 10 } }, { name: 'search_knowledge', args: { query: 'duplicate charges' } }, { name: 'submit_decision', args: finalDecision }]);
  try {
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: api.url, homeRoot, timeoutMs: 25000 });
    let checks = 0;
    const ctx = context({ assertActive: async () => { checks++; } });
    const result = await model.decide(ctx, new AbortController().signal);
    assert.deepEqual(result.decision, finalDecision);
    assert.deepEqual(result.toolCalls, ['lookup_payments', 'search_knowledge', 'submit_decision']);
    assert.equal(api.requests.length, 3);
    for (const request of api.requests) assert.deepEqual(request.tools?.map(tool => tool.function.name).sort(), [...SUPPORT_TOOLS].sort());
    assert.doesNotMatch(JSON.stringify(api.requests), /sessionToken|demo-olena/);
    assert.ok(checks >= 7, 'ownership must be checked at each tool and final delivery');
    assert.match(JSON.stringify(api.requests[2]?.messages), /Duplicate charges/);
    // Simulate losing the application mapping after native checkpoint: durable DSH history must still restore.
    const marker = (await readdir(homeRoot, { recursive: true })).find(path => path.endsWith('support-session.json'));
    assert.ok(marker); await unlink(join(homeRoot, marker));
    const resumed = await model.decide({ ...ctx, runId: 'run-2', message: 'Can you confirm the next step?' }, new AbortController().signal);
    assert.deepEqual(resumed.decision, finalDecision);
    assert.equal(api.requests.length, 6);
    assert.match(JSON.stringify(api.requests[3]?.messages), /You charged me twice/);
    assert.match(JSON.stringify(api.requests[3]?.messages), /Can you confirm/);
  } finally { await stop(api.server); await rm(homeRoot, { recursive: true, force: true }); }
});

test('actual installed DSH denies hallucinated shell tools and cancellation closes the runtime child', { timeout: 60000 }, async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'support-runtime-cancel-'));
  const api = await endpoint([{ name: 'bash', args: { command: 'echo forbidden' } }, { name: 'submit_decision', args: { ...finalDecision, action: null } }]);
  try {
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: api.url, homeRoot, timeoutMs: 25000 });
    const result = await model.decide(context({ conversationId: 'malicious-tool' }), new AbortController().signal);
    assert.deepEqual(result.toolCalls, ['submit_decision']);
    assert.match(JSON.stringify(api.requests[1]?.messages), /outside the support gateway allowlist/i);
  } finally { await stop(api.server); }
  const hanging = await endpoint([], true);
  try {
    const controller = new AbortController();
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: hanging.url, homeRoot, timeoutMs: 25000 });
    const result = model.decide(context({ conversationId: 'cancel-me' }), controller.signal);
    await Promise.race([hanging.firstRequest, result.then(() => { throw new Error('Runtime completed before contacting the model'); })]);
    controller.abort(new Error('Ownership changed'));
    await assert.rejects(result, /Ownership|abort|closed|shutdown|cancel/i);
    assert.equal(hanging.requests.length, 1);
  } finally { await stop(hanging.server); await rm(homeRoot, { recursive: true, force: true }); }
});

test('profile has no coding bundles and child environment excludes business credentials', async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'support-runtime-profile-'));
  try {
    const profile = await prepareProfile({ homeRoot, businessId: 'org', conversationId: 'c', ownershipVersion: 1, provider: 'google', model: 'gemini-3.5-flash-lite' });
    const manifest = JSON.parse(await readFile(join(profile.home, 'profiles', 'support', 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dsh.profile.bundles, []);
    const patch = await readFile(join(profile.home, 'profiles', 'support', 'cordis.patch.yml'), 'utf8');
    assert.doesNotMatch(patch, /dsh-base|tool-bash|tool-pwsh|tool-fs|mcp-client|tool-subagent|plugin-manager/);
    const env = childEnvironment({ apiKey: 'synthetic-model-key', gatewayUrl: 'http://127.0.0.1:1/tool-calls', capability: 'synthetic-capability', maxToolCalls: 8, home: profile.home });
    // The child never inherits the service user's home: it gets the profile's own, writable directory.
    assert.equal(env.HOME, profile.home);
    assert.equal(env.DSH_AGENTS_HOME, join(profile.home, 'agents'));
    // Containers mount /tmp noexec: on Linux the native addon must load in place, not from a /tmp copy.
    assert.equal(env.NARB_DISABLE_NATIVE_CACHE, process.platform === 'win32' ? undefined : '1');
    assert.equal(env.POSTGRES_PASSWORD, undefined);
    assert.equal(env.OPERATOR_TOKEN, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.SUPPORT_MODEL_API_KEY, 'synthetic-model-key');
  } finally { await rm(homeRoot, { recursive: true, force: true }); }
});

test('actual installed DSH closes on ownership revocation and bounds repeated unknown tool attempts', { timeout: 60000 }, async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'support-runtime-fence-'));
  const hanging = await endpoint([], true);
  try {
    let active = true;
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: hanging.url, homeRoot, timeoutMs: 25000 });
    const result = model.decide(context({ conversationId: 'takeover', assertActive: async () => { if (!active) throw new Error('Staff took ownership'); } }), new AbortController().signal);
    await Promise.race([hanging.firstRequest, result.then(() => { throw new Error('Runtime completed before contacting the model'); })]);
    active = false;
    await assert.rejects(result, /Staff took ownership/);
    assert.equal(hanging.requests.length, 1);
  } finally { await stop(hanging.server); }
  const malicious = await endpoint([{ name: 'bash', args: { command: 'forbidden' } }]);
  try {
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: malicious.url, homeRoot, timeoutMs: 25000, maxToolCalls: 2 });
    await assert.rejects(model.decide(context({ conversationId: 'runaway' }), new AbortController().signal), /without a valid support decision/);
    assert.equal(malicious.requests.length, 2);
  } finally { await stop(malicious.server); await rm(homeRoot, { recursive: true, force: true }); }
});

test('actual installed DSH exposes a fourth scoped integration gateway tool only for configured tools', { timeout: 60000 }, async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'support-runtime-integration-'));
  const api = await endpoint([
    { name: 'call_business_tool', args: { integrationId: 'not-allowed', name: 'get_order', input: {} } },
    { name: 'call_business_tool', args: { integrationId: 'test-orders', name: 'get_order', input: { reference: 'TEST-1' } } },
    { name: 'submit_decision', args: { ...finalDecision, intent: 'other', action: null, reply: 'The test order is shipped.' } },
  ]);
  try {
    let forwarded = 0;
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: api.url, homeRoot, timeoutMs: 25000 });
    const result = await model.decide(context({ conversationId: 'integration',
      businessTools: [{ integrationId: 'test-orders', name: 'get_order', description: 'Read the authenticated customer order.', inputSchema: { type: 'object' } }],
      callBusinessTool: async (integrationId, name, input, signal) => {
        assert.equal(integrationId, 'test-orders'); assert.equal(name, 'get_order');
        assert.deepEqual(input, { reference: 'TEST-1' }); assert.equal(signal?.aborted, false);
        forwarded++; return { reference: 'TEST-1', status: 'shipped' };
      },
    }), new AbortController().signal);
    assert.equal(forwarded, 1, 'forged integration ids must not reach the core adapter');
    assert.equal(result.decision.reply, 'The test order is shipped.');
    assert.equal(api.requests.length, 3);
    for (const request of api.requests) assert.deepEqual(request.tools?.map(tool => tool.function.name).sort(), [...SUPPORT_TOOLS, 'call_business_tool'].sort());
    assert.match(JSON.stringify(api.requests[2]?.messages), /shipped/);
  } finally { await stop(api.server); await rm(homeRoot, { recursive: true, force: true }); }
});

test('actual installed DSH uses the configured category enum and isolates changed taxonomy sessions', { timeout: 60000 }, async () => {
  const homeRoot = await mkdtemp(join(tmpdir(), 'support-runtime-classification-'));
  const classification = classificationConfigSchema.parse({ revision: 1, fallbackClassId: 'other', classes: [
    { id: '1', label: 'Billing', description: 'Invoice and payment questions.', examples: ['Where is my invoice?'] },
    { id: 'other', label: 'Other', description: 'No configured category fits.' },
  ] });
  const script = [{ name: 'submit_decision', args: { ...finalDecision, intent: 'billing_question', action: null,
    classification: { classId: '1', confidence: 0.91, reason: 'The customer asks for an invoice.' } } }];
  const api = await endpoint(script);
  try {
    const model = new DshSupportModel({ provider: 'local', model: 'support-fixture', baseURL: api.url, homeRoot, timeoutMs: 25000 });
    const initial = context({ conversationId: 'configured-category', classification, message: 'Where is my invoice?' });
    const result = await model.decide(initial, new AbortController().signal);
    assert.deepEqual(result.decision.classification, script[0]!.args.classification);
    const terminal = api.requests[0]?.tools?.find(tool => tool.function.name === 'submit_decision');
    const schema = terminal?.function.parameters as { properties: { classification: { properties: { classId: { enum: string[] } } } }; required: string[] };
    assert.deepEqual(schema.properties.classification.properties.classId.enum, ['1', 'other']);
    assert.equal(schema.required.includes('classification'), true);
    assert.match(JSON.stringify(api.requests[0]?.messages), /Where is my invoice/);
    assert.match(JSON.stringify(api.requests[0]?.messages), /minimumConfidence/);
    const changed = classificationConfigSchema.parse({ ...classification, revision: 2, classes: [
      { id: '2', label: 'Shipping', description: 'Delivery status questions.' }, classification.classes[1],
    ] });
    script[0] = { name: 'submit_decision', args: { ...script[0]!.args, classification: { classId: '2', confidence: 0.94, reason: 'The customer asks for delivery status.' } } };
    const next = await model.decide({ ...initial, runId: 'run-2', classification: changed, message: 'Where is the parcel?' }, new AbortController().signal);
    assert.deepEqual(next.decision.classification, script[0]!.args.classification);
    const changedTerminal = api.requests[1]?.tools?.find(tool => tool.function.name === 'submit_decision');
    const nextSchema = changedTerminal?.function.parameters as typeof schema;
    assert.deepEqual(nextSchema.properties.classification.properties.classId.enum, ['2', 'other']);
    const sessions = (await readdir(homeRoot, { recursive: true })).filter(path => path.endsWith('support-session.json'));
    assert.equal(sessions.length, 2, 'a changed taxonomy must not reuse the old native category context');
  } catch (error) {
    const last = api.requests.at(-1)?.messages ?? [];
    const toolErrors = last.filter(message => message && typeof message === 'object' && (message as { role?: string }).role === 'tool').slice(-3).map(message => JSON.stringify(message).slice(0, 300));
    throw new Error(`Native category fixture failed after ${api.requests.length} local model requests; tool responses: ${JSON.stringify(toolErrors)}`, { cause: error });
  } finally { await stop(api.server); await rm(homeRoot, { recursive: true, force: true }); }
});
