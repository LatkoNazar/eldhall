import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision, type AgentModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const OLENA = 'demo-olena';

function setup(model: AgentModel = new RulesModel()) {
  const store = new MemorySupportStore();
  void store.reset(seedData());
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 200 });
  return { store, harness };
}

const decision = (patch: Partial<AgentDecision>): AgentDecision => ({
  intent: 'other', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply: '', action: null, ...patch,
});

test('F2: second case cannot open a parallel refund proposal for the same payment', async () => {
  const { store, harness } = setup();
  const a = await harness.openCase(OLENA);
  const first = await harness.runTurn(OLENA, a.id, 'You charged me twice for October');
  assert.equal(first.proposal?.status, 'pending');
  const b = await harness.openCase(OLENA);
  await harness.runTurn(OLENA, b.id, 'You charged me twice for October');
  const all = [...await store.proposals(a.id), ...await store.proposals(b.id)];
  const pending = all.filter(p => p.tool === 'refund_payment' && p.status === 'pending');
  assert.equal(pending.length, 1);
  const denied = (await store.proposals(b.id)).find(p => p.tool === 'refund_payment');
  assert.equal(denied?.status, 'denied');
  assert.ok(denied?.policy.checks.some(c => c.name === 'no_open_proposal' && !c.passed));
});

test('F7: completion claim in free-form reply is not delivered', async () => {
  const reply = 'Done! Your 499 UAH is already back on your card.';
  const { harness } = setup(new ScriptedModel(() => decision({ reply })));
  const opened = await harness.openCase(OLENA);
  const turn = await harness.runTurn(OLENA, opened.id, 'Where is my money?');
  assert.equal(turn.proposal, null);
  assert.notEqual(turn.reply?.body, reply);
  assert.doesNotMatch(turn.reply!.body, /back on your card/);
});

test('F7: cancel_subscription without proposal uses a template', async () => {
  const reply = 'I have cancelled your subscription.';
  const { harness } = setup(new ScriptedModel(() => decision({ intent: 'cancel_subscription', reply })));
  const opened = await harness.openCase(OLENA);
  const turn = await harness.runTurn(OLENA, opened.id, 'Can you stop my plan?');
  assert.equal(turn.proposal, null);
  assert.notEqual(turn.reply?.body, reply);
  assert.match(turn.reply!.body, /cannot cancel the subscription automatically/);
});
