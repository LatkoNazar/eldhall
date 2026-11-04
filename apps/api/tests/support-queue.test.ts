import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, type AgentContext } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { createSupportMaintenance, processSupportTurn, publishPendingTurns } from '../src/modules/support/turn-processor.js';

const fixture = () => {
  const store = new MemorySupportStore(seedData());
  const rules = new RulesModel();
  let calls = 0;
  const contexts: AgentContext[] = [];
  const model = { provider: 'rules', model: 'counted-rules', decide: async (...args: Parameters<RulesModel['decide']>) => { calls++; contexts.push(args[0]); return rules.decide(...args); } };
  const harness = new SupportHarness({ store, model, fallback: rules, provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  return { store, harness, calls: () => calls, contexts };
};

test('durable acceptance records input once; broker redelivery does not rerun or duplicate output', async () => {
  const h = fixture();
  const c = await h.harness.openCase('demo-olena');
  const clientId = randomUUID();
  const accepted = await h.harness.enqueueTurn('demo-olena', c.id, 'charged twice', clientId);
  const repeated = await h.harness.enqueueTurn('demo-olena', c.id, 'charged twice', clientId);
  assert.equal(repeated.job?.id, accepted.job?.id);
  assert.equal(h.calls(), 0, 'submission never calls the model');
  assert.equal((await h.store.messages(c.id)).length, 1);
  await assert.rejects(h.harness.enqueueTurn('demo-olena', c.id, 'different', clientId));
  await assert.rejects(publishPendingTurns(h.store, async () => { throw new Error('broker offline'); }));
  assert.equal((await h.store.pendingTurnJobs()).length, 1, 'publish failure cannot lose the committed outbox entry');
  const delivered: string[] = [];
  await publishPendingTurns(h.store, async id => { delivered.push(id); });
  await publishPendingTurns(h.store, async id => { delivered.push(id); });
  for (const id of delivered) await processSupportTurn(id, 'worker-one', h.store, h.harness);
  assert.equal(h.calls(), 1);
  assert.equal((await h.store.messages(c.id)).filter(message => message.role === 'customer').length, 1);
  assert.equal((await h.store.messages(c.id)).filter(message => message.role === 'assistant').length, 1);
  assert.equal((await h.store.proposals(c.id)).length, 1);
  assert.equal(await h.store.activeTurnJob(c.id), null);
  assert.equal((await h.store.runs(c.id))[0]?.turnJobId, accepted.job?.id);
});

test('normal queued turns keep stable native conversation identity and fresh verified history', async () => {
  const h = fixture();
  const c = await h.harness.openCase('demo-olena');
  const first = await h.harness.enqueueTurn('demo-olena', c.id, 'hello');
  await processSupportTurn(first.job!.id, 'worker', h.store, h.harness);
  const second = await h.harness.enqueueTurn('demo-olena', c.id, 'thank you');
  await processSupportTurn(second.job!.id, 'worker', h.store, h.harness);
  assert.notEqual(h.contexts[0]?.runId, h.contexts[1]?.runId);
  assert.equal(h.contexts[0]?.conversationId, h.contexts[1]?.conversationId);
  assert.equal(h.contexts[0]?.ownershipVersion, h.contexts[1]?.ownershipVersion);
  assert.equal(h.contexts[0]?.runtimeAttempt, undefined);
  assert.equal(h.contexts[1]?.runtimeAttempt, undefined);
  assert.ok(h.contexts[1]?.history.some(message => message.body === 'hello'));
});

test('staff takeover cancels queued work and customer messages stay with staff', async () => {
  const h = fixture();
  const c = await h.harness.openCase('demo-olena');
  const queued = await h.harness.enqueueTurn('demo-olena', c.id, 'charged twice');
  await h.store.setOwnership(c.id, 'staff', 'operator:staff');
  await processSupportTurn(queued.job!.id, 'worker', h.store, h.harness);
  assert.equal(h.calls(), 0);
  const next = await h.harness.enqueueTurn('demo-olena', c.id, 'please help');
  assert.equal(next.job, null);
  assert.equal((await h.store.messages(c.id)).length, 2);
});

test('worker HTTP returns 202 and progress history; API submission makes zero model calls', async () => {
  const h = fixture();
  const app = await createApp(settingsFrom({ API_TOKEN: 't', OPERATOR_TOKEN: 'op' }), {
    store: {} as never, dispatch: async () => undefined, checks: {},
    support: { store: h.store, harness: h.harness, execution: 'worker' },
  });
  const headers = { host: 'testserver', 'x-customer-session': 'demo-olena' };
  try {
    const c = (await app.inject({ method: 'POST', url: '/api/v1/chat/cases', headers })).json();
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/chat/cases/' + c.id + '/messages', headers, payload: { body: 'charged twice', clientMessageId: randomUUID() } });
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal(accepted.json().reply, null);
    assert.equal(h.calls(), 0);
    const queued = (await app.inject({ url: '/api/v1/chat/cases/' + c.id, headers })).json();
    assert.equal(queued.activeRun.status, 'queued');
    await processSupportTurn(accepted.json().runId, 'worker', h.store, h.harness);
    const finished = (await app.inject({ url: '/api/v1/chat/cases/' + c.id, headers })).json();
    assert.equal(finished.activeRun, null);
    assert.equal(finished.messages.filter((message: { role: string }) => message.role === 'assistant').length, 1);
  } finally {
    await app.close();
  }
});

test('worker maintenance expires unattended approvals and recovers dispatched actions without overlapping timer ticks',async()=>{
  const h=fixture();const pendingCase=await h.harness.openCase('demo-olena');const interruptedCase=await h.harness.openCase('demo-olena');
  const customer=(await h.store.customerBySession('demo-olena'))!;
  const proposal=async(supportCase:typeof pendingCase,expired:boolean)=>{
    const args={businessId:customer.businessId,customerId:customer.id,caseId:supportCase.id,ownershipVersion:supportCase.ownershipVersion,integrationId:'orders',operationKey:'POST /orders/{order_id}/cancel',title:'Cancel order',effect:'write',managed:false,expiresAt:new Date(Date.now()+(expired?-1000:900000)).toISOString(),input:{order_id:'ORD-1001'}};
    return h.store.createProposal({caseId:supportCase.id,tool:'external_action',args,argsHash:randomUUID(),risk:'high',status:'pending',policy:{allowed:true,requiresApproval:true,checks:[]}});
  };
  const pending=await proposal(pendingCase,true);const interrupted=await proposal(interruptedCase,false);
  assert.ok(await h.store.decideProposal(interrupted.id,interrupted.argsHash,'approved','operator:test'));assert.ok(await h.store.claimExecution(interrupted.id,interrupted.argsHash,'operator:test'));assert.ok(await h.store.markExternalDispatched(interrupted.id));h.store.proposalRows.get(interrupted.id)!.decidedAt=new Date(Date.now()-181000).toISOString();
  let clock=0;let runs=0;let active=0;let maximum=0;let release:()=>void=()=>undefined;const blocked=new Promise<void>(resolve=>{release=resolve;});
  const maintain=createSupportMaintenance({recoverInterruptedExecutions:async()=>{runs++;active++;maximum=Math.max(maximum,active);try{await h.store.recoverInterruptedExecutions();if(runs===1) await blocked;}finally{active--;}}},()=>clock);
  const first=maintain();assert.equal(maintain(),first);clock=100000;assert.equal(maintain(),first);release();await first;
  assert.equal(runs,1);assert.equal(maximum,1);assert.equal((await h.store.proposal(pending.id))!.status,'expired');assert.equal((await h.store.proposal(interrupted.id))!.status,'unknown');assert.equal((await h.store.getCase(pendingCase.id))!.ownership,'staff');assert.equal((await h.store.getCase(interruptedCase.id))!.ownership,'staff');
  const messages=(await h.store.messages(interruptedCase.id)).length;await maintain();clock=109999;await maintain();assert.equal(runs,1);clock=110000;await maintain();assert.equal(runs,2);assert.equal(maximum,1);assert.equal((await h.store.messages(interruptedCase.id)).length,messages);
});

test('a failed lifecycle sweep releases its shared promise and retries at the next bounded cadence',async()=>{
  let clock=0;let calls=0;const maintain=createSupportMaintenance({recoverInterruptedExecutions:async()=>{calls++;if(calls===1) throw new Error('database temporarily unavailable');}},()=>clock);
  await assert.rejects(maintain(),/temporarily unavailable/);await maintain();assert.equal(calls,1);clock=10000;await maintain();assert.equal(calls,2);
});
