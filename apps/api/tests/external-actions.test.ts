import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionOutcome, BusinessIntegrations, BusinessToolResult } from '../src/integrations/mcp.js';
import { HarnessError, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const OLENA = 'demo-olena';
const decision = (patch: Partial<AgentDecision> = {}): AgentDecision => ({
  intent: 'other', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply: 'Ваше замовлення вже скасовано!', action: null, ...patch,
});

/** Integration double: the catalog's contract (propose during a turn, executeAction afterwards) without a network. */
function setup(mode: 'ask' | 'auto', outcomes: (() => Promise<ActionOutcome>)[], inputs: Record<string, unknown>[] = [{ order_id: 'ORD-1001' }]) {
  const store = new MemorySupportStore();
  void store.reset(seedData());
  const executed: { actionId: string; args: Record<string, unknown> }[] = [];
  const results: BusinessToolResult[] = [];
  const integrations: BusinessIntegrations = { forContext(ctx) {
    return {
      tools: [{ integrationId: 'orders', name: 'cancel_order', description: 'Cancel order', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      callTool: async (_integrationId, _name, input) => ctx.propose!({ mode, title: 'Cancel order', args: { integrationId: 'orders', operationKey: 'POST /orders/{order_id}/cancel', title: 'Cancel order', policyRevision: 1, customerId: ctx.customerId, input } }),
      executeAction: async (args, actionId) => { executed.push({ args, actionId }); return outcomes.shift()!(); },
    };
  } };
  const model = new ScriptedModel(async ctx => {
    for (const input of inputs) results.push(await ctx.callBusinessTool!('orders', 'cancel_order', input) as BusinessToolResult);
    return decision();
  });
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000, integrations });
  return { store, harness, executed, results };
}
const turn = async (h: ReturnType<typeof setup>) => {
  const opened = await h.harness.openCase(OLENA);
  const result = await h.harness.runTurn(OLENA, opened.id, 'Скасуйте, будь ласка, моє замовлення ORD-1001');
  const proposal = (await h.store.proposals(opened.id)).find(p => p.tool === 'external_action')!;
  return { caseId: opened.id, result, proposal };
};
const done = async () => ({ status: 'executed' as const, data: { order_id: 'ORD-1001', status: 'cancelled' } });

test('ask: proposal only, honest pending reply; approve does nothing; execute dispatches once with the proposal id', async () => {
  const h = setup('ask', [done]);
  const { caseId, result, proposal } = await turn(h);
  assert.deepEqual(h.results, [{ status: 'awaiting_approval', proposalId: proposal.id, summary: 'Cancel order' }]);
  assert.equal(proposal.status, 'pending');
  assert.equal(result.case.status, 'awaiting_approval');
  assert.match(result.reply!.body, /підготував запит «Cancel order».*підтвердити спеціаліст/);
  assert.doesNotMatch(result.reply!.body, /скасовано/); // the model's premature success claim never reaches the customer
  assert.equal(h.executed.length, 0);

  await h.harness.approve(proposal.id, 'anna', proposal.argsHash);
  assert.equal(h.executed.length, 0);
  const executed = await h.harness.executeApproved(proposal.id, 'anna', proposal.argsHash);
  assert.equal(executed.proposal.status, 'executed');
  assert.deepEqual(executed.proposal.result, { data: { order_id: 'ORD-1001', status: 'cancelled' } });
  assert.equal(executed.case.status, 'resolved');
  assert.deepEqual(h.executed.map(row => row.actionId), [proposal.id]);
  assert.equal((await h.store.messages(caseId)).at(-1)!.body, 'Дію «Cancel order» виконано (статус: cancelled).');
  await assert.rejects(h.harness.executeApproved(proposal.id, 'anna', proposal.argsHash), (error: unknown) => error instanceof HarnessError && error.status === 409);
  assert.equal(h.executed.length, 1);
  const audit = (await h.store.auditEvents(caseId)).find(row => row.type === 'action.executed')!;
  assert.equal(audit.data.origin, 'operator_approval');
});

test('ask: tampered hash and rejection never dispatch', async () => {
  const h = setup('ask', []);
  const { caseId, proposal } = await turn(h);
  await assert.rejects(h.harness.approve(proposal.id, 'anna', 'f'.repeat(64)), (error: unknown) => error instanceof HarnessError && error.status === 409);
  const rejected = await h.harness.reject(proposal.id, 'anna', 'not eligible');
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(h.executed.length, 0);
  assert.match((await h.store.messages(caseId)).at(-1)!.body, /не погодив дію «Cancel order»/);
});

test('execute: unknown outcome or executor crash stays locked for reconciliation; failure is reported as failure', async () => {
  for (const [outcome, status] of [
    [async () => ({ status: 'unknown' as const, reasonCode: 'outcome_unknown' }), 'unknown'],
    [async () => { throw new Error('socket hang up'); }, 'unknown'],
    [async () => ({ status: 'failed' as const, reasonCode: 'conflict' }), 'failed'],
  ] as const) {
    const h = setup('ask', [outcome]);
    const { caseId, proposal } = await turn(h);
    await h.harness.approve(proposal.id, 'anna', proposal.argsHash);
    const result = await h.harness.executeApproved(proposal.id, 'anna', proposal.argsHash);
    assert.equal(result.proposal.status, status);
    assert.equal(result.case.status, 'escalated');
    assert.equal(result.case.ownership, 'staff');
    assert.match((await h.store.messages(caseId)).at(-1)!.body, status === 'unknown' ? /не підтверджено/ : /не виконано/);
    await assert.rejects(h.harness.executeApproved(proposal.id, 'anna', proposal.argsHash), (error: unknown) => error instanceof HarnessError && error.status === 409);
    assert.equal(h.executed.length, 1);
  }
});

test('auto: same ledger, executed inside the turn, recorded as policy_auto; unknown escalates the case', async () => {
  const h = setup('auto', [done]);
  const { caseId, result, proposal } = await turn(h);
  assert.deepEqual(h.results, [{ status: 'executed', actionId: proposal.id, data: { order_id: 'ORD-1001', status: 'cancelled' } }]);
  assert.equal(proposal.status, 'executed');
  assert.equal(proposal.decidedBy, 'agent:auto');
  assert.match(result.reply!.body, /Дію «Cancel order» виконано \(статус: cancelled\)\.$/);
  assert.equal((await h.store.auditEvents(caseId)).find(row => row.type === 'action.executed')!.data.origin, 'policy_auto');

  const unsure = setup('auto', [async () => ({ status: 'unknown', reasonCode: 'outcome_unknown' })]);
  const second = await turn(unsure);
  assert.equal(second.proposal.status, 'unknown');
  assert.equal(second.result.case.status, 'escalated');
  assert.equal(second.result.case.ownership, 'staff');
  assert.match(second.result.reply!.body, /не підтверджено/);
});

test('one external action per turn: a second different action is denied, a repeat returns the same proposal', async () => {
  const h = setup('ask', [], [{ order_id: 'ORD-1001' }, { order_id: 'ORD-1001' }, { order_id: 'ORD-1002' }]);
  const { caseId, proposal } = await turn(h);
  assert.deepEqual(h.results.map(r => r.status), ['awaiting_approval', 'awaiting_approval', 'denied']);
  assert.equal((h.results[1] as { proposalId: string }).proposalId, proposal.id);
  assert.deepEqual(h.results[2], { status: 'denied', reasonCode: 'one_external_action_per_turn' });
  assert.equal((await h.store.proposals(caseId)).filter(p => p.tool === 'external_action').length, 1);
});
