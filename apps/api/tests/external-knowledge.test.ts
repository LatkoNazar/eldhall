import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentContext, type AgentDecision } from '../src/modules/agent/model.js';
import type { ExternalKnowledge, ExternalKnowledgeRef } from '../src/modules/knowledge/qdrant.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { seedData } from '../src/modules/support/seed.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';

const answer: AgentDecision = { intent: 'other', summary: 'Company guide', reasoning: 'Verified company source', sentiment: { label: 'calm', urgency: 'low' }, reply: 'REMOTE_GUIDE says office hours are 9–17.', action: null };
const ref: ExternalKnowledgeRef = { connectorId: 'company-kb', pointId: 42, contentHash: 'a'.repeat(64) };
async function fixture(script: (ctx: AgentContext) => Promise<AgentDecision>, timeoutMs = 1000) {
  const store = new MemorySupportStore();
  await store.reset(seedData());
  const customer = (await store.customerBySession('demo-olena'))!;
  let enabled = true;
  let current = true;
  let failSearch = false;
  const external: ExternalKnowledge = {
    hasBusiness: id => enabled && id === customer.businessId,
    describe: () => ({ id: 'company-kb', collection: 'company', embedder: 'fixture' }),
    search: async scope => {
      assert.equal(scope.businessId, customer.businessId); assert.equal(scope.plan, customer.plan);
      if (failSearch) throw new Error('Synthetic remote outage');
      return { hits: [{ id: 'qdrant:company-kb:42', title: 'Company guide', content: 'REMOTE_GUIDE says office hours are 9–17.', version: 1, section: 'Hours' }], refs: [ref] };
    },
    validate: async (scope, refs) => scope.businessId === customer.businessId && enabled && current && refs.every(item => item.contentHash === ref.contentHash),
  };
  const harness = new SupportHarness({ store, model: new ScriptedModel(script), fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs, externalKnowledge: external });
  const supportCase = await harness.openCase('demo-olena');
  return { store, harness, supportCase, external, setCurrent: (value: boolean) => { current = value; }, setEnabled: (value: boolean) => { enabled = value; }, setFailSearch: () => { failSearch = true; } };
}

test('external retrieval does not import documents and followups carry provenance into fresh native sessions', async () => {
  const contexts: AgentContext[] = [];
  const f = await fixture(async ctx => {
    contexts.push(ctx);
    assert.deepEqual(ctx.knowledge, []);
    if (contexts.length === 1) assert.match((await ctx.searchKnowledge('office hours'))[0]!.content, /REMOTE_GUIDE/);
    else assert.match(JSON.stringify(ctx.history), /REMOTE_GUIDE/);
    return answer;
  });
  const countBefore = (await f.store.knowledge((await f.store.customerBySession('demo-olena'))!.businessId)).length;
  const first = await f.harness.runTurn('demo-olena', f.supportCase.id, 'office hours');
  const second = await f.harness.runTurn('demo-olena', f.supportCase.id, 'and tomorrow?');
  assert.deepEqual(first.reply!.sourceRefs, []);
  assert.deepEqual(first.reply!.externalSourceRefs, [ref]);
  assert.deepEqual(second.reply!.externalSourceRefs, [ref]);
  assert.ok(contexts[0]!.knowledgeSessionKey && contexts[1]!.knowledgeSessionKey);
  assert.notEqual(contexts[0]!.knowledgeSessionKey, contexts[1]!.knowledgeSessionKey);
  assert.equal((await f.store.knowledge((await f.store.customerBySession('demo-olena'))!.businessId)).length, countBefore);
  f.setCurrent(false);
  const history = await f.harness.customerCase('demo-olena', f.supportCase.id);
  assert.ok(history.messages.filter(message => message.role === 'assistant').every(message => !message.body.includes('REMOTE_GUIDE')));
  f.setCurrent(true); f.setEnabled(false);
  assert.ok((await f.harness.customerCase('demo-olena', f.supportCase.id)).messages.filter(message => message.role === 'assistant').every(message => !message.body.includes('REMOTE_GUIDE')));
});

test('external content changes before completion fence the answer without a local UUID citation', async () => {
  const f = await fixture(async ctx => { await ctx.searchKnowledge('office hours'); f.setCurrent(false); return answer; });
  await assert.rejects(f.harness.runTurn('demo-olena', f.supportCase.id, 'office hours'), /External knowledge changed/);
  assert.equal((await f.store.messages(f.supportCase.id)).filter(message => message.role === 'assistant').length, 0);
});

test('remote search failure cannot be swallowed by the model to produce an ungrounded fallback answer', async () => {
  const f = await fixture(async ctx => { await ctx.searchKnowledge('office hours').catch(() => undefined); return answer; });
  f.setFailSearch();
  await assert.rejects(f.harness.runTurn('demo-olena', f.supportCase.id, 'office hours'), /External knowledge is unavailable/);
  assert.equal((await f.store.messages(f.supportCase.id)).filter(message => message.role === 'assistant').length, 0);
});

test('history validation uses a shared deadline and hides an unavailable remote response', async () => {
  const f = await fixture(async ctx => { await ctx.searchKnowledge('office hours'); return answer; }, 300);
  await f.harness.runTurn('demo-olena', f.supportCase.id, 'office hours');
  let cancelled = false;
  f.external.validate = async (_scope, _refs, signal) => new Promise(resolve => {
    assert.ok(signal);
    if (signal.aborted) { cancelled = true; resolve(false); }
    else signal.addEventListener('abort', () => { cancelled = true; resolve(false); }, { once: true });
  });
  // Keep the loop alive: production network sockets do this for the unref'ed deadline.
  const alive = setInterval(() => undefined, 50);
  try {
    const history = await f.harness.customerCase('demo-olena', f.supportCase.id);
    assert.equal(cancelled, true);
    assert.ok(history.messages.filter(message => message.role === 'assistant').every(message => !message.body.includes('REMOTE_GUIDE')));
  } finally { clearInterval(alive); }
});
