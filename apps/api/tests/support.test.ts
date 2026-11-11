import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { HarnessError, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision, type AgentModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const OLENA = 'demo-olena';
const DUP_LATER = '00000000-0000-4000-8000-000000000202';   // Olena's 2nd October charge
const DUP_FIRST = '00000000-0000-4000-8000-000000000201';
const TARAS_PAYMENT = '00000000-0000-4000-8000-000000000204';

function setup(model: AgentModel = new RulesModel()) {
  const store = new MemorySupportStore();
  void store.reset(seedData());
  const provider = new SimulatedPaymentProvider();
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider, timeoutMs: 200 });
  return { store, provider, harness };
}

const decision = (patch: Partial<AgentDecision>): AgentDecision => ({
  intent: 'duplicate_charge', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply: '', action: null, ...patch,
});

async function duplicateTurn(h: ReturnType<typeof setup>, text = 'You charged me twice for October!!! Fix it now') {
  const opened = await h.harness.openCase(OLENA);
  const turn = await h.harness.runTurn(OLENA, opened.id, text);
  return { caseId: opened.id, turn };
}

async function approveAndExecute(h: ReturnType<typeof setup>, proposal: NonNullable<Awaited<ReturnType<typeof duplicateTurn>>['turn']['proposal']>) {
  const approved = await h.harness.approve(proposal.id, 'anna', proposal.argsHash);
  assert.equal(approved.proposal.status, 'approved');
  assert.equal((await h.store.refunds()).length, 0);
  return h.harness.executeApproved(proposal.id, 'anna', proposal.argsHash);
}

test('1. duplicate charge: approved refund updates payment, refund, case and audit', async () => {
  const h = setup();
  const { caseId, turn } = await duplicateTurn(h);
  assert.equal(turn.proposal?.tool, 'refund_payment');
  assert.equal(turn.proposal?.args.payment_id, DUP_LATER);
  const result = await approveAndExecute(h, turn.proposal!);
  assert.equal(result.proposal.status, 'executed');
  assert.equal(result.case.status, 'open');
  assert.equal((await h.store.requestCatalog(caseId)).requests[0]!.lifecycle, 'open');
  assert.equal((await h.store.payment(DUP_LATER))?.status, 'refunded');
  assert.equal((await h.store.payment(DUP_FIRST))?.status, 'captured');
  assert.equal((await h.store.refunds()).length, 1);
  const types = (await h.store.auditEvents(caseId)).map(e => e.type);
  for (const type of ['message.received', 'agent.analyzed', 'action.proposed', 'action.approved', 'action.executed']) assert.ok(types.includes(type), type);
  assert.match((await h.store.messages(caseId)).at(-1)!.body, /SIM-RF-/);
});

test('2. unsupported request (cancellation) creates no money action and escalates', async () => {
  const h = setup();
  const opened = await h.harness.openCase(OLENA);
  const turn = await h.harness.runTurn(OLENA, opened.id, 'Please cancel my subscription');
  assert.equal(turn.proposal?.tool, 'escalate_to_human');
  assert.equal(turn.case.status, 'escalated');
  assert.equal((await h.store.refunds()).length, 0);
});

test('customer reply and action receipt use the conversation language independently of the operator handoff', async () => {
  const summary = 'Клієнт повідомляє про подвійне списання.';
  const model = new ScriptedModel(async ctx => {
    assert.equal(ctx.operatorLanguage, 'uk');
    assert.ok(!('responseStyle' in ctx.business));
    const catalog = await ctx.checkpointRequests!({
      version: ctx.requestCatalog!().version, syncState: 'current',
      changes: [{
        localKey: 'refund', title: 'Перевірити подвійне списання', goal: summary, waitingOn: null, nextStep: null,
        sourceMessageIds: [ctx.currentCustomerMessageId!], dependencyIds: [], dependencyKeys: [],
      }],
    });
    const request = catalog.requests[0]!;
    return decision({
      summary, reasoning: 'Повернення другого платежу потребує погодження.',
      replyLanguage: 'es-MX', sentiment: { label: 'frustrated', urgency: 'medium' },
      action: { tool: 'refund_payment', args: { payment_id: DUP_LATER, amount_cents: 49900 }, requests: [{ id: request.id, revision: request.revision }] },
    });
  });
  const h = setup(Object.assign(model, { requestCatalogProtocol: 'checkpoint-v1' as const }));
  const { caseId, turn } = await duplicateTurn(h, 'Me cobraron dos veces. Necesito ayuda.');
  assert.equal(turn.case.analysis?.summary, summary);
  assert.equal(turn.case.analysis?.tone, 'empathetic');
  assert.match(turn.reply?.body ?? '', /Un especialista debe aprobarlo/);
  assert.ok(turn.proposal);
  await approveAndExecute(h, turn.proposal);
  assert.match((await h.store.messages(caseId)).at(-1)?.body ?? '', /No se movió dinero real/);
});

test('3. missing information: no duplicate found -> clarifying question, no proposal', async () => {
  const h = setup();
  const opened = await h.harness.openCase('demo-taras');
  const turn = await h.harness.runTurn('demo-taras', opened.id, 'I think you charged me twice');
  assert.equal(turn.proposal, null);
  assert.equal(turn.case.status, 'open');
  assert.match(turn.reply!.body, /date and amount/);
});

test('4. policy denies: another customer\'s payment id, non-duplicate, over limit', async () => {
  const foreign = setup(new ScriptedModel(() => decision({ action: { tool: 'refund_payment', args: { payment_id: TARAS_PAYMENT, amount_cents: 19900 } } })));
  const a = await duplicateTurn(foreign, `Refund payment ${TARAS_PAYMENT}`);
  assert.equal(a.turn.proposal?.status, 'denied');
  assert.ok(a.turn.proposal?.policy.checks.some(c => c.name === 'payment_belongs_to_customer' && !c.passed));
  assert.equal(a.turn.case.status, 'escalated');

  const notDuplicate = setup(new ScriptedModel(() => decision({ action: { tool: 'refund_payment', args: { payment_id: '00000000-0000-4000-8000-000000000203', amount_cents: 49900 } } })));
  const b = await duplicateTurn(notDuplicate);
  assert.ok(b.turn.proposal?.policy.checks.some(c => c.name === 'duplicate_detected' && !c.passed));

  const big = setup();
  const opened = await big.harness.openCase('demo-ivan');
  const c = await big.harness.runTurn('demo-ivan', opened.id, 'You charged my annual plan twice');
  assert.equal(c.proposal?.status, 'denied');
  assert.ok(c.proposal?.policy.checks.some(check => check.name === 'within_refund_limit' && !check.passed));
  assert.equal((await big.store.refunds()).length, 0);
});

test('5. refund requires approval: nothing executes before a human decides', async () => {
  const h = setup();
  const { turn } = await duplicateTurn(h);
  assert.equal(turn.proposal?.status, 'pending');
  assert.equal(turn.case.status, 'awaiting_approval');
  assert.equal((await h.store.refunds()).length, 0);
  assert.doesNotMatch(turn.reply!.body, /has been approved|refunded/i);
});

test('6. rejected approval: no refund, customer informed', async () => {
  const h = setup();
  const { caseId, turn } = await duplicateTurn(h);
  const result = await h.harness.reject(turn.proposal!.id, 'anna', 'Customer already got a credit');
  assert.equal(result.proposal.status, 'rejected');
  assert.equal((await h.store.refunds()).length, 0);
  assert.match((await h.store.messages(caseId)).at(-1)!.body, /did not approve/);
  await assert.rejects(h.harness.approve(turn.proposal!.id, 'anna', turn.proposal!.argsHash), (e: HarnessError) => e.status === 409);
});

test('7. duplicate approval and tampered approval are refused; one refund only', async () => {
  const h = setup();
  const { turn } = await duplicateTurn(h);
  await assert.rejects(h.harness.approve(turn.proposal!.id, 'anna', 'f'.repeat(64)), (e: HarnessError) => e.status === 409 && /does not match/.test(e.message));
  await approveAndExecute(h, turn.proposal!);
  await assert.rejects(h.harness.approve(turn.proposal!.id, 'anna', turn.proposal!.argsHash), (e: HarnessError) => e.status === 409);
  // The customer asks again: policy blocks a second refund proposal for the same payment.
  const again = await h.harness.runTurn(OLENA, turn.case.id, 'you charged me twice again');
  assert.notEqual(again.proposal?.status, 'pending');
  assert.equal((await h.store.refunds()).length, 1);
});

test('8. LLM failure or timeout falls back to rules and is recorded', async () => {
  for (const model of [new ScriptedModel(() => { throw new Error('503 from provider'); }), new ScriptedModel(() => new Promise<never>(() => undefined))]) {
    const h = setup(model);
    const { caseId, turn } = await duplicateTurn(h);
    const [run] = await h.store.runs(caseId);
    assert.equal(run?.status, 'fallback');
    assert.ok(run?.error);
    assert.equal((await h.store.getCase(caseId))?.analysis?.source, 'fallback');
    assert.equal(turn.proposal?.status, 'pending');
  }
  const invalid = setup(new ScriptedModel(() => ({ intent: 'hack' }) as unknown as AgentDecision));
  const { caseId } = await duplicateTurn(invalid);
  assert.equal((await invalid.store.runs(caseId))[0]?.status, 'fallback');
});

test('9. payment provider failure: proposal failed, honest reply, no refund recorded', async () => {
  const h = setup();
  h.provider.failing.add(DUP_LATER);
  const { caseId, turn } = await duplicateTurn(h);
  const result = await approveAndExecute(h, turn.proposal!);
  assert.equal(result.proposal.status, 'failed');
  assert.equal((await h.store.payment(DUP_LATER))?.status, 'captured');
  assert.equal((await h.store.refunds()).length, 0);
  assert.match((await h.store.messages(caseId)).at(-1)!.body, /No refund has been made/);
});

test('10. abusive message: P1 + escalation; frustration alone never authorises money', async () => {
  const h = setup();
  const opened = await h.harness.openCase('demo-taras');
  const turn = await h.harness.runTurn('demo-taras', opened.id, 'YOU IDIOTS give me my money back NOW!!!');
  const analysis = (await h.store.getCase(opened.id))!.analysis!;
  assert.equal(analysis.sentiment.abusive, true);
  assert.equal(analysis.priority, 'P1');
  assert.equal(analysis.tone, 'de-escalating');
  assert.equal(turn.case.status, 'escalated');
  assert.equal((await h.store.refunds()).length, 0);

  const frustrated = setup();
  const { turn: dup } = await duplicateTurn(frustrated, 'Ви списали двічі!!! Це жах, негайно поверніть');
  const a = (await frustrated.store.getCase(dup.case.id))!.analysis!;
  assert.equal(a.sentiment.abusive, false);
  assert.equal(a.priority, 'P1');
  assert.equal(dup.proposal?.status, 'pending');  // still waits for a human
});

test('model replies claiming a refund without execution are replaced in the conversation language', async () => {
  for (const [language, input, reply, fallback] of [
    ['en', 'Hello', 'Good news, we have refunded you!', /looking into/],
    ['es', 'Hola', 'Ya te devolví el dinero a tu tarjeta.', /revisando tu consulta/],
    ['de', 'Hallo', 'Ich habe den Betrag bereits erstattet.', /prüfe Ihre Anfrage/],
    ['pt', 'Olá', 'Já lhe devolvi o dinheiro.', /verificar o pedido/],
  ] as const) {
    const h = setup(new ScriptedModel(() => decision({ intent: 'other', reply, replyLanguage: language })));
    const { turn } = await duplicateTurn(h, input);
    assert.match(turn.reply!.body, fallback);
  }
});

test('HTTP: customer session scoping, operator auth and approval flow', async () => {
  const h = setup();
  const app = await createApp(settingsFrom({ API_TOKEN: 't', OPERATOR_TOKEN: 'op-token' }), { store: {} as never, dispatch: async () => undefined, checks: {}, support: { harness: h.harness, store: h.store } });
  const host = { host: 'testserver' };
  const op = { ...host, authorization: 'Bearer op-token' };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/chat/cases', headers: host })).statusCode, 401);
    const opened = await app.inject({ method: 'POST', url: '/api/v1/chat/cases', headers: { ...host, 'x-customer-session': OLENA } });
    assert.equal(opened.statusCode, 201);
    assert.equal(opened.json().isTest, false);
    const id = opened.json().id;
    const own = await app.inject({ url: `/api/v1/chat/cases/${id}`, headers: { ...host, 'x-customer-session': OLENA } });
    assert.equal(own.json().businessName, 'NovaPay Fitness');
    assert.equal((await app.inject({ url: '/api/v1/chat/personas', headers: host })).json()[0].businessName, 'NovaPay Fitness');
    const foreign = await app.inject({ url: `/api/v1/chat/cases/${id}`, headers: { ...host, 'x-customer-session': 'demo-taras' } });
    assert.equal(foreign.statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/chat/cases/${id}/messages`, headers: { ...host, 'x-customer-session': OLENA }, payload: { body: '' } })).statusCode, 422);
    const turn = await app.inject({ method: 'POST', url: `/api/v1/chat/cases/${id}/messages`, headers: { ...host, 'x-customer-session': OLENA }, payload: { body: 'charged twice!!' } });
    assert.equal(turn.statusCode, 200, turn.body);
    assert.equal(turn.json().status, 'awaiting_approval');
    assert.equal(turn.json().proposal, undefined);   // internals stay on the operator side
    assert.equal((await app.inject({ url: '/api/v1/cases', headers: host })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/cases?environment=test', headers: host })).statusCode, 401);
    const detail = (await app.inject({ url: `/api/v1/cases/${id}`, headers: op })).json();
    const proposal = detail.proposals[0];
    assert.equal(detail.case.isTest, false);
    assert.equal(detail.customer.sessionToken, undefined);
    const approve = (hash: string) => app.inject({ method: 'POST', url: `/api/v1/proposals/${proposal.id}/approve`, headers: op, payload: { operator: 'anna', argsHash: hash } });
    assert.equal((await approve(proposal.argsHash)).statusCode, 200);
    assert.equal((await h.store.refunds()).length, 0);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/proposals/${proposal.id}/execute`, headers: op, payload: { argsHash: proposal.argsHash } })).statusCode, 200);
    assert.equal((await approve(proposal.argsHash)).statusCode, 409);
    assert.equal((await h.store.refunds())[0]?.amountCents, 49900);
    const metrics = (await app.inject({ url: '/api/v1/metrics', headers: op })).json();
    assert.equal(metrics.cases, 1);
    assert.equal(metrics.agentRuns, 1);
    assert.equal(metrics.proposals.executed, 1);
    assert.equal(metrics.refundsIssuedCents, 49900);

    const created = await app.inject({ method: 'POST', url: '/api/v1/customers', headers: op, payload: {
      businessId: detail.case.businessId, name: 'Ordinary customer', email: 'ordinary@example.test', plan: 'Standard',
    } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/chat/test-cases', headers: { ...host, 'x-customer-session': created.json().sessionToken } })).statusCode, 403);
    const testCase = await app.inject({ method: 'POST', url: '/api/v1/chat/test-cases', headers: { ...host, 'x-customer-session': OLENA } });
    assert.equal(testCase.statusCode, 201, testCase.body);
    assert.equal(testCase.json().isTest, true);
    const testId = testCase.json().id;
    for (const caseId of [id, testId]) {
      assert.equal((await app.inject({ method: 'POST', url: `/api/v1/cases/${caseId}/takeover`, headers: op })).statusCode, 200);
    }
    const listed = async (query = '') => (await app.inject({ url: `/api/v1/cases${query}`, headers: op })).json<{ id: string; isTest: boolean }[]>();
    assert.deepEqual((await listed()).map(row => [row.id, row.isTest]), [[id, false]]);
    assert.deepEqual((await listed('?environment=test&status=escalated')).map(row => [row.id, row.isTest]), [[testId, true]]);
    assert.deepEqual(await listed('?environment=test&status=open'), []);
    assert.equal((await app.inject({ url: '/api/v1/cases?environment=all', headers: op })).statusCode, 422);
    assert.equal((await app.inject({ url: '/api/v1/metrics', headers: op })).json().cases, 1);
    assert.equal((await app.inject({ url: '/api/v1/team', headers: op })).json().members[0].assignedCases, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/demo/reset', headers: op })).statusCode, 200);
    assert.deepEqual(await listed(), []);
    assert.deepEqual(await listed('?environment=test'), []);

    const [alteredIdentity, rotatedToken, knownPersona] = seedData().customers;
    await h.store.createCustomer({ ...alteredIdentity!, email: 'ordinary-with-reused-id@example.test' });
    await h.store.createCustomer({ ...rotatedToken!, sessionToken: 'synthetic-rotated-private-token' });
    const personas = (await app.inject({ url: '/api/v1/chat/personas', headers: host })).json<{ sessionToken: string }[]>();
    assert.ok(personas.some(persona => persona.sessionToken === knownPersona!.sessionToken));
    assert.ok(personas.every(persona => ![alteredIdentity!.sessionToken, rotatedToken!.sessionToken, 'synthetic-rotated-private-token'].includes(persona.sessionToken)));
  } finally { await app.close(); }
});

test('LLM key comes from the provider-specific variable, not process.env', () => {
  assert.equal(settingsFrom({ LLM_PROVIDER: 'google', GOOGLE_GENERATIVE_AI_API_KEY: 'g-key', OPENAI_API_KEY: 'o-key' }).llmApiKey, 'g-key');
  assert.equal(settingsFrom({}).llmApiKey, '');
});
