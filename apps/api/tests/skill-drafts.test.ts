import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { parseSkillContext } from '../src/modules/agent/context.js';
import { RulesModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { supportRoutes } from '../src/modules/support/routes.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { DshGuardDraftModel, DshSkillDraftModel } from '../src/runtime/skill-draft-model.js';

test('drafts use scoped existing skills, never save automatically, and only link enabled local skills', async () => {
  const data = seedData();
  const [business, other] = data.businesses;
  assert.ok(business && other);
  const store = new MemorySupportStore(data);
  const local = { id: randomUUID(), businessId: business.id, name: 'custom/check-charge', revision: 1, enabled: true,
    content: 'Verify captured payments against the customer statement.', updatedAt: new Date().toISOString() };
  const disabled = { ...local, id: randomUUID(), name: 'custom/old-charge', enabled: false };
  const foreign = { ...local, id: randomUUID(), businessId: other.id, content: 'FOREIGN_SKILL_CANARY' };
  await Promise.all([store.saveSkill(local), store.saveSkill(disabled), store.saveSkill(foreign)]);
  const app = Fastify();
  const rules = new RulesModel();
  const harness = new SupportHarness({ store, model: rules, fallback: rules, provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  let modelCalls = 0;
  let reference = local.id;
  await app.register(supportRoutes, {
    operatorToken: 'synthetic-operator', demoResetEnabled: false,
    support: { store, harness, workspaceBusinessId: business.id, skillDraftModel: {
      async generate(input, scopedBusinessId) {
        modelCalls++;
        assert.equal(scopedBusinessId, business.id);
        assert.match(JSON.stringify(input), /Verify captured payments/);
        assert.doesNotMatch(JSON.stringify(input), /FOREIGN_SKILL_CANARY/);
        return { slug: 'check-charge', purpose: 'Customer reports a second charge', instructions: 'Check the recorded payment details before escalating.',
          related: [{ id: reference, kind: 'reuse', reason: 'Existing payment verification procedure.' }] };
      },
    } },
  });
  const headers = { authorization: 'Bearer synthetic-operator' };
  const url = `/api/v1/skills/draft?businessId=${business.id}`;
  const payload = { description: 'Help customers investigate a possible duplicate charge.' };
  try {
    assert.equal((await app.inject({ method: 'POST', url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/skills/draft?businessId=${other.id}`, headers, payload })).statusCode, 404);
    assert.equal(modelCalls, 0);
    const generated = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(generated.statusCode, 200, generated.body);
    const draft = generated.json<{ slug: string; content: string; related: { id: string }[] }>();
    assert.equal(draft.slug, 'check-charge-2');
    assert.equal(draft.related[0]?.id, local.id);
    assert.equal((await store.skills(business.id)).length, 2);

    reference = foreign.id;
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 502);
    const saveUrl = `/api/v1/skills?businessId=${business.id}`;
    const save = (relatedId: string) => app.inject({ method: 'POST', url: saveUrl, headers,
      payload: { name: `custom/${draft.slug}`, content: draft.content, enabled: false, relatedSkillIds: [relatedId] } });
    assert.equal((await save(foreign.id)).statusCode, 422);
    assert.equal((await save(disabled.id)).statusCode, 422);
    const saved = await save(local.id);
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.json().enabled, false);
    assert.equal(parseSkillContext(saved.json()).activation, 'on_demand');
    assert.match(saved.json().content, new RegExp(local.id));
    assert.equal((await save(local.id)).statusCode, 409);
  } finally { await app.close(); }
});

test('native skill and guard drafts return JSON without tools and remove their isolated profiles', { timeout: 65_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-draft-test-'));
  const skill = { slug: 'check-charge', purpose: 'When a customer reports two charges', instructions: 'Check payment records.', related: [] };
  const guard = { guard: { kind: 'amount_limit', name: 'Limit refunds', reason: 'Workspace limit', target: { tool: 'refund_payment' }, maxAmountCents: 50000, currency: 'UAH' } };
  let payload: unknown = skill;
  const received: { tools?: unknown[]; messages?: unknown[] }[] = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    function chunk(delta: unknown, finish: string | null = null) {
      response.write(`data: ${JSON.stringify({ id: 'draft', object: 'chat.completion.chunk', created: 1, model: 'draft-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    }
    chunk({ role: 'assistant', content: JSON.stringify(payload) });
    chunk({}, 'stop');
    response.end('data: [DONE]\n\n');
  })().catch(() => { response.destroy(); }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const options = { provider: 'local' as const, model: 'draft-fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, homeRoot: root };
    const model = new DshSkillDraftModel(options);
    const result = await model.generate({ description: 'A fictional workflow', skills: [], totalSkills: 0, tools: [], guardKinds: [] }, 'synthetic', new AbortController().signal);
    assert.deepEqual(result, skill);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.tools?.length ?? 0, 0);
    assert.match(JSON.stringify(received[0]?.messages), /A fictional workflow/);
    assert.deepEqual(await readdir(root), []);
    payload = guard;
    const generated = await new DshGuardDraftModel(options).generate({ description: 'Limit refunds to 500 UAH', currency: 'UAH', existingGuards: [], targets: { tools: ['refund_payment', 'external_action'], integrations: [] } }, 'synthetic', new AbortController().signal);
    assert.deepEqual(generated, guard);
    assert.equal(received.length, 2);
    assert.equal(received[1]?.tools?.length ?? 0, 0);
    assert.match(JSON.stringify(received[1]?.messages), /Limit refunds to 500 UAH/);
    assert.match(JSON.stringify(received[1]?.messages), /Draft exactly one additional support guard/);
    assert.doesNotMatch(JSON.stringify(received[1]?.messages), /A fictional workflow/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
