import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { DshInsightsModel } from '../src/runtime/insights-model.js';
import { prepareProfile } from '../src/runtime/profile.js';
import { emptySample, type InsightInput } from '../src/modules/insights/contracts.js';
import { validateFindings } from '../src/modules/insights/service.js';

test('actual native DSH insights has one read-only terminal tool, rejects money tools and returns scoped structured findings', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'insights-runtime-'));
  const input: InsightInput = { tickets: [1, 2].map(() => ({ id: randomUUID(), messages: [{ id: randomUUID(), role: 'customer', body: 'Synthetic invoice download error.' }] })), knowledge: [], sourceRefs: [], sample: { ...emptySample(), caseCount: 2, messageCount: 2 } };
  const findings = { findings: [{ kind: 'recurring_issue', title: 'Synthetic invoice error', summary: 'Two sampled dialogues report invoice download trouble; the cause is unknown.', recommendation: 'Investigate the sample errors.',
    evidence: input.tickets.map(ticket => ({ caseId: ticket.id, messageIds: [ticket.messages[0]!.id] })), knowledgeRefs: [], proposedArticle: null }] };
  const requests: { tools?: { function: { name: string } }[]; messages?: unknown[] }[] = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const operation = requests.length === 1 ? { name: 'refund_payment', args: { payment_id: 'forbidden' } } : { name: 'submit_insights', args: findings };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const write = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({ id: `insights-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'insights-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    write({ role: 'assistant', content: '' });
    write({ tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: operation.name, arguments: JSON.stringify(operation.args) } }] });
    write({}, 'tool_calls');
    response.end('data: [DONE]\n\n');
  })().catch(() => { response.writeHead(500); response.end(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const model = new DshInsightsModel({ provider: 'local', model: 'insights-fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, homeRoot: root, timeoutMs: 60000 });
    const result = await model.analyze(input, { businessId: 'synthetic-business', runId: 'synthetic-insights', assertActive: async () => undefined }, new AbortController().signal);
    assert.deepEqual(result, findings);
    assert.equal(validateFindings(input, result)[0]?.caseCount, 2);
    assert.equal(requests.length, 2);
    requests.forEach(request => assert.deepEqual(request.tools?.map(tool => tool.function.name), ['submit_insights']));
    assert.match(JSON.stringify(requests[1]?.messages), /outside the read-only insights allowlist/);
    assert.doesNotMatch(JSON.stringify(requests), /sessionToken|OPERATOR_TOKEN|POSTGRES_PASSWORD/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('insights profile isolates purpose while default support profile retains native session identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'insights-purpose-'));
  try {
    const options = { homeRoot: root, businessId: 'org', conversationId: 'run', ownershipVersion: 0, provider: 'google', model: 'gemini-3.5-flash-lite' };
    const support = await prepareProfile(options);
    const expected = createHash('sha256').update(JSON.stringify(['org', 'run', 0])).digest('hex');
    assert.equal(support.sessionId, `support-${expected}`);
    const insights = await prepareProfile({ ...options, purpose: 'insights' });
    assert.notEqual(insights.home, support.home);
    const patch = await readFile(join(insights.home, 'profiles', 'support', 'cordis.patch.yml'), 'utf8');
    assert.match(patch, /insights-gateway/);
    assert.doesNotMatch(patch, /support-gateway\.mjs|dsh-base|tool-bash|tool-pwsh|tool-fs|mcp-client|subagent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
