import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ActionOutcome, BusinessIntegrationContext, BusinessIntegrations, BusinessToolResult } from '../src/integrations/mcp.js';
import { HarnessError, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const OLENA = 'demo-olena';
const decision = (patch: Partial<AgentDecision> = {}): AgentDecision => ({
  intent: 'other', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply: 'Ваше замовлення вже скасовано!', action: null, ...patch,
});
const requestArgs=(ctx:BusinessIntegrationContext,input:Record<string,unknown>)=>({integrationId:'orders',operationKey:'POST /orders/{order_id}/cancel',title:'Cancel order',policyRevision:1,
  businessId:ctx.businessId,customerId:ctx.customerId,caseId:ctx.caseId,ownershipVersion:ctx.ownershipVersion,expiresAt:new Date(Date.now()+900000).toISOString(),effect:'write',managed:false,input});

/** Integration double: the catalog's contract (propose during a turn, executeAction afterwards) without a network. */
function setup(mode: 'ask' | 'auto', outcomes: (() => Promise<ActionOutcome>)[], inputs: Record<string, unknown>[] = [{ order_id: 'ORD-1001' }]) {
  const store = new MemorySupportStore();
  void store.reset(seedData());
  const executed: { actionId: string; args: Record<string, unknown> }[] = [];
  const results: BusinessToolResult[] = [];
  const integrations: BusinessIntegrations = { forContext(ctx) {
    return {
      tools: [{ integrationId: 'orders', name: 'cancel_order', description: 'Cancel order', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      callTool: async (_integrationId, _name, input) => ctx.propose!({ mode, title: 'Cancel order', args: requestArgs(ctx,input) }),
      executeAction: async (args, actionId) => { await ctx.markDispatched?.();executed.push({ args, actionId }); return outcomes.shift()!(); },
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
  assert.equal(executed.case.status, 'open');
  assert.equal((await h.store.requestCatalog(caseId)).requests[0]!.lifecycle, 'open');
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
  const second=await unsure.harness.openCase(OLENA);
  await assert.rejects(unsure.harness.runTurn(OLENA,second.id,'Скасуйте замовлення'),(error:unknown)=>error instanceof HarnessError&&error.status===409);
  assert.equal((await unsure.store.proposals(second.id))[0]!.status,'unknown');
  assert.equal((await unsure.store.getCase(second.id))!.status,'escalated');
  assert.equal((await unsure.store.getCase(second.id))!.ownership,'staff');
  assert.match((await unsure.store.messages(second.id)).at(-1)!.body,/не підтверджено/);
});

test('one external action per turn: a second different action is denied, a repeat returns the same proposal', async () => {
  const h = setup('ask', [], [{ order_id: 'ORD-1001' }, { order_id: 'ORD-1001' }, { order_id: 'ORD-1002' }]);
  const { caseId } = await turn(h);
  assert.deepEqual(h.results.map(r => r.status), ['awaiting_approval', 'denied', 'denied']);
  assert.deepEqual(h.results[1], { status: 'denied', reasonCode: 'turn_awaiting_approval' });
  assert.deepEqual(h.results[2], { status: 'denied', reasonCode: 'turn_awaiting_approval' });
  assert.equal((await h.store.proposals(caseId)).filter(p => p.tool === 'external_action').length, 1);
});

test('pending ask read/write ends a scripted turn, blocks dependent tools and prevents builtin money or handoff proposals',async()=>{
  for(const effect of ['read','write']) for(const builtin of ['refund_payment','escalate_to_human']) {
    const store=new MemorySupportStore(seedData());let calls=0;let aborted=false;let completeAttempts!:()=>void;
    const attempted=new Promise<void>(resolve=>{completeAttempts=resolve;});
    const integrations:BusinessIntegrations={forContext:ctx=>({tools:[{integrationId:'orders',name:'reviewed_tool',description:'Needs approval',inputSchema:{type:'object',properties:{},additionalProperties:false}}],
      callTool:async(_integrationId,_name,input)=>{calls++;return ctx.propose!({mode:'ask',title:'Reviewed order request',args:{...requestArgs(ctx,input),effect}});},
      executeAction:async()=>{throw new Error('A pending request must not execute');},
    })};
    const later:unknown[]=[];
    const model={provider:'scripted',model:'pending-adversary',async decide(ctx:import('../src/modules/agent/model.js').AgentContext,signal:AbortSignal){
      signal.addEventListener('abort',()=>{aborted=true;},{once:true});
      const pending=await ctx.callBusinessTool!('orders','reviewed_tool',{});later.push(pending);
      later.push(await ctx.callBusinessTool!('orders','reviewed_tool',{}));
      await assert.rejects(ctx.searchKnowledge('read after pending'),/awaiting operator approval/);
      completeAttempts();
      return{decision:decision({action:builtin==='refund_payment'?{tool:builtin,args:{payment_id:'00000000-0000-4000-8000-000000000202',amount_cents:49900}}:{tool:builtin,args:{reason:'forced continuation'}},sentiment:{label:'abusive',urgency:'high'}}),steps:2,toolCalls:[]};
    }};
    const harness=new SupportHarness({store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000,integrations});
    const opened=await harness.openCase(OLENA);const result=await harness.runTurn(OLENA,opened.id,'Шахраї! Скасуйте замовлення негайно!');await attempted;
    assert.equal(calls,1);assert.equal(aborted,true);assert.deepEqual(later[1],{status:'denied',reasonCode:'turn_awaiting_approval'});
    const proposals=await store.proposals(opened.id);assert.equal(proposals.length,1);assert.equal(proposals[0]!.tool,'external_action');assert.equal(proposals[0]!.status,'pending');assert.equal(proposals[0]!.args.effect,effect);
    assert.equal(result.case.status,'awaiting_approval');assert.equal(result.case.ownership,'bot');assert.match(result.reply!.body,/підготував запит.*підтвердити спеціаліст/);assert.equal((await store.refunds()).length,0);
  }
});

test('pending request completes the application turn without waiting for a custom model to continue',async()=>{
  const store=new MemorySupportStore(seedData());let stopped=false;let stopReason:unknown;
  const integrations:BusinessIntegrations={forContext:ctx=>({tools:[{integrationId:'orders',name:'ask_read',description:'Ask read',inputSchema:{type:'object',properties:{},additionalProperties:false}}],callTool:async(_id,_name,input)=>ctx.propose!({mode:'ask',title:'Reviewed read',args:{...requestArgs(ctx,input),effect:'read'}})})};
  const model={provider:'scripted',model:'waits-after-pending',async decide(ctx:import('../src/modules/agent/model.js').AgentContext,signal:AbortSignal){
    await ctx.callBusinessTool!('orders','ask_read',{});
    return new Promise<never>((_resolve,reject)=>{if(signal.aborted){stopped=true;stopReason=signal.reason;reject(new Error('pending stopped'));return;}signal.addEventListener('abort',()=>{stopped=true;stopReason=signal.reason;reject(new Error('pending stopped'));},{once:true});});
  }};
  const harness=new SupportHarness({store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000,integrations});const opened=await harness.openCase(OLENA);
  const result=await harness.runTurn(OLENA,opened.id,'Перевірте замовлення');assert.equal(stopped,true);assert.ok(stopReason instanceof Error);assert.equal(stopReason.message,'Turn is awaiting operator approval');assert.equal(result.case.status,'awaiting_approval');assert.equal((await store.proposals(opened.id)).length,1);
});

test('store: agent:auto can claim only proposals recorded without approval; ask and refunds stay with the operator', async () => {
  const h = setup('ask', []);
  const { caseId, proposal } = await turn(h);
  assert.equal(await h.store.claimProposal(proposal.id, proposal.argsHash, 'executing', 'agent:auto'), null);
  assert.equal((await h.store.proposal(proposal.id))!.status, 'pending');
  const policy = { ...proposal.policy, requiresApproval: false };
  const auto = await h.store.createProposal({ caseId, tool: 'external_action', args: { ...proposal.args,input:{n:2} }, argsHash: 'b'.repeat(64), risk: 'high', status: 'pending', policy });
  assert.equal((await h.store.claimProposal(auto.id, auto.argsHash, 'executing', 'agent:auto'))?.status, 'executing');
  const refund = await h.store.createProposal({ caseId, tool: 'refund_payment', args: { payment_id: 'x' }, argsHash: 'c'.repeat(64), risk: 'high', status: 'pending', policy });
  assert.equal(await h.store.claimProposal(refund.id, refund.argsHash, 'executing', 'agent:auto'), null);
});

test('model prose claiming a business effect is replaced when nothing was recorded this turn', async () => {
  for (const reply of ['Ваше замовлення вже скасовано!', 'Я скасував ваше замовлення.', 'Your order has been cancelled.', "We've cancelled your order ORD-1001."]) {
    const h = setup('ask', [], []);
    const store = h.store;
    const harness = new SupportHarness({ store, model: new ScriptedModel(() => decision({ reply })), fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
    const opened = await harness.openCase(OLENA);
    const result = await harness.runTurn(OLENA, opened.id, reply.includes('order') ? 'Please cancel my order' : 'Скасуйте замовлення');
    assert.notEqual(result.reply!.body, reply, reply);
    assert.doesNotMatch(result.reply!.body, /скасовано|скасував|cancell?ed/i);
  }
  // Plain status information stays untouched.
  const h = setup('ask', [], []);
  const harness = new SupportHarness({ store: h.store, model: new ScriptedModel(() => decision({ reply: 'Статус замовлення ORD-1001: shipped, трекінг надіслано.' })), fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const opened = await harness.openCase(OLENA);
  assert.equal((await harness.runTurn(OLENA, opened.id, 'Де моє замовлення?')).reply!.body, 'Статус замовлення ORD-1001: shipped, трекінг надіслано.');
});

test('parallel tool calls in one turn cannot run two external actions (inline mode, no durable turn key)', async () => {
  for (const second of [{ order_id: 'ORD-1002' }, { order_id: 'ORD-1001' }]) {
    const h = setup('auto', [done, done]);
    const parallel = new ScriptedModel(async ctx => {
      h.results.push(...await Promise.all([ctx.callBusinessTool!('orders', 'cancel_order', { order_id: 'ORD-1001' }), ctx.callBusinessTool!('orders', 'cancel_order', second)]) as BusinessToolResult[]);
      return decision();
    });
    const harness = new SupportHarness({ store: h.store, model: parallel, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000, integrations: (h.harness as unknown as { deps: { integrations: BusinessIntegrations } }).deps.integrations });
    const opened = await harness.openCase(OLENA);
    await harness.runTurn(OLENA, opened.id, 'Скасуйте замовлення');
    const proposals = (await h.store.proposals(opened.id)).filter(p => p.tool === 'external_action');
    assert.equal(proposals.length, 1);
    assert.equal(h.executed.length, 1);
    if (second.order_id === 'ORD-1002') assert.deepEqual(h.results[1], { status: 'denied', reasonCode: 'one_external_action_per_turn' });
    else assert.deepEqual(h.results[1], h.results[0]); // same request: same proposal, no second dispatch
  }
});

/** A read-only integration double: what the model learned this turn is the only ground for status claims. */
async function replyAfterRead(status: string | null, reply: string) {
  const store = new MemorySupportStore();
  void store.reset(seedData());
  const integrations: BusinessIntegrations = { forContext: () => ({
    tools: [{ integrationId: 'orders', name: 'get_order_status', description: 'Read order', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    callTool: async () => ({ order_id: 'ORD-1001', status }),
  }) };
  const model = new ScriptedModel(async ctx => {
    if (status !== null) await ctx.callBusinessTool!('orders', 'get_order_status', { order_id: 'ORD-1001' });
    return decision({ reply });
  });
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000, integrations });
  const opened = await harness.openCase(OLENA);
  return (await harness.runTurn(OLENA, opened.id, 'Що з моїм замовленням?')).reply!.body;
}

test('claims guard: action claims are always replaced; state claims pass only when this turn read that state', async () => {
  for (const reply of ['Done! Order #1001 cancelled.', 'Your order has now been cancelled.', 'Your order has been successfully cancelled.', 'Order ORD-1001 cancelled successfully',
    'I cancelled it for you.', "I've updated your delivery address.", 'Cancellation confirmed', 'Замовлення відмінено.', 'Вашу заявку оформлено.', 'Повернення коштів оформлено.', 'Скасування підтверджено.']) {
    assert.notEqual(await replyAfterRead(null, reply), reply, reply);
  }
  // First-person claims stay blocked even when the order really is cancelled: the agent did not do it this turn.
  assert.notEqual(await replyAfterRead('cancelled', 'I cancelled it for you.'), 'I cancelled it for you.');
  for (const reply of ['Your order ORD-1001 was cancelled on 3 May.', 'Status: your order is cancelled.', 'Ваше замовлення було скасовано продавцем.']) {
    assert.equal(await replyAfterRead('cancelled', reply), reply, reply);
    assert.notEqual(await replyAfterRead('paid', reply), reply, `${reply} without matching data`);
  }
  assert.equal(await replyAfterRead('refunded', 'Order ORD-1002 was refunded last week.'), 'Order ORD-1002 was refunded last week.');
  assert.equal(await replyAfterRead(null, 'Інформація оновилася, перевірте email.'), 'Інформація оновилася, перевірте email.');
  assert.equal(await replyAfterRead('shipped', 'Статус замовлення ORD-1001: shipped.'), 'Статус замовлення ORD-1001: shipped.');
});

test('in-turn auto dispatch is fenced by the turn: a takeover before dispatch stops the write', async () => {
  const store = new MemorySupportStore();
  void store.reset(seedData());
  let dispatched = false;
  const integrations: BusinessIntegrations = { forContext(ctx) {
    return {
      tools: [{ integrationId: 'orders', name: 'cancel_order', description: 'Cancel order', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      callTool: async (_i, _n, input) => ctx.propose!({ mode: 'auto', title: 'Cancel order', args: requestArgs(ctx,input) }),
      // Mirrors catalog.ts: the context fence runs right before dispatch; failing it means nothing was sent.
      executeAction: async () => {
        const caseId = (await store.listCases())[0]!.id;
        await store.setOwnership(caseId, 'staff', 'operator:staff');
        try { await ctx.assertActive(); } catch { return { status: 'failed', reasonCode: 'unavailable' }; }
        dispatched = true;
        return { status: 'executed', data: {} };
      },
    };
  } };
  const model = new ScriptedModel(async ctx => { await ctx.callBusinessTool!('orders', 'cancel_order', { order_id: 'ORD-1001' }).catch(() => undefined); return decision(); });
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000, integrations });
  const opened = await harness.openCase(OLENA);
  await harness.runTurn(OLENA, opened.id, 'Скасуйте замовлення').catch(() => undefined);
  assert.equal(dispatched, false);
  assert.equal((await store.proposals(opened.id)).find(p => p.tool === 'external_action')?.status, 'failed');
});

test('customer template quotes only a short plain upstream status', async () => {
  for (const [status, shown] of [['cancelled', true], ['<img src=x onerror=alert(1)>', false], ['x'.repeat(41), false]] as const) {
    const h = setup('auto', [async () => ({ status: 'executed', data: { status } })]);
    const { result } = await turn(h);
    assert.equal(result.reply!.body.includes('(статус:'), shown, status);
  }
});

test('auto completion survives takeover after the effect and is recorded exactly once',async()=>{
  let takeover:()=>Promise<void>=async()=>undefined;
  const h=setup('auto',[async()=>{await takeover();return done();}]);
  const opened=await h.harness.openCase(OLENA);takeover=async()=>{await h.store.setOwnership(opened.id,'staff','operator:takeover');};
  await assert.rejects(h.harness.runTurn(OLENA,opened.id,'Скасуйте замовлення'),(error:unknown)=>error instanceof HarnessError&&error.status===409);
  const proposal=(await h.store.proposals(opened.id))[0]!;assert.equal(proposal.status,'executed');assert.equal((await h.store.getCase(opened.id))!.ownership,'staff');
  assert.equal((await h.store.messages(opened.id)).filter(row=>row.role==='assistant').length,1);
  await h.store.finishExternalAction(proposal.id,'unknown',null,'late_error','Wrong duplicate','system');
  assert.equal((await h.store.messages(opened.id)).filter(row=>row.role==='assistant').length,1);
  const audit=await h.store.auditEvents(opened.id);for(const event of ['action.claimed','action.dispatched','action.executed']) assert.equal(audit.filter(row=>row.type===event).length,1);
});

test('durable turn retry after a crash reuses the action identity and completion message',async()=>{
  const h=setup('auto',[done]);const opened=await h.harness.openCase(OLENA);
  const accepted=await h.store.enqueueTurn(opened.id,(await h.store.customerBySession(OLENA))!.id,'Скасуйте замовлення',randomUUID());
  const first=(await h.store.claimTurnJob(accepted.job!.id,'worker:first'))!;
  const complete=h.store.completeTurn.bind(h.store);h.store.completeTurn=async()=>{throw new Error('simulated crash before final turn commit');};
  await assert.rejects(h.harness.runQueued(first.job,first.lease),/simulated crash/);h.store.completeTurn=complete;
  const action=(await h.store.proposals(opened.id))[0]!;assert.equal(action.status,'executed');assert.equal(h.executed.length,1);
  assert.equal((await h.store.messages(opened.id)).filter(row=>row.role==='assistant').length,1);
  await h.store.failTurnJob(first.lease,'simulated crash',true);await new Promise(resolve=>setTimeout(resolve,1010));
  const retry=(await h.store.claimTurnJob(accepted.job!.id,'worker:retry'))!;assert.ok(retry);const recovered=await h.harness.runQueued(retry.job,retry.lease);
  assert.equal(h.executed.length,1);assert.equal((await h.store.proposals(opened.id)).length,1);assert.equal((await h.store.messages(opened.id)).filter(row=>row.role==='assistant').length,1);assert.match(recovered.reply!.body,/виконано/);
});

test('expiry first discovered by approval is terminal, audited and visible without a later scan',async()=>{
  const h=setup('ask',[]);const {caseId,proposal}=await turn(h);h.store.proposalRows.get(proposal.id)!.args.expiresAt=new Date(Date.now()-1000).toISOString();
  await assert.rejects(h.harness.approve(proposal.id,'operator',proposal.argsHash),(error:unknown)=>error instanceof HarnessError&&error.status===409);
  assert.equal((await h.store.proposal(proposal.id))!.status,'expired');assert.equal((await h.store.getCase(caseId))!.status,'escalated');assert.equal((await h.store.getCase(caseId))!.ownership,'staff');
  const messages=(await h.store.messages(caseId)).length;await h.store.expireExternalActions();assert.equal((await h.store.messages(caseId)).length,messages);assert.equal((await h.store.auditEvents(caseId)).filter(row=>row.type==='action.expired').length,1);
});

test('customer history refresh expires only the authenticated own case without an operator visit',async()=>{
  const h=setup('ask',[]);const {caseId,proposal}=await turn(h);h.store.proposalRows.get(proposal.id)!.args.expiresAt=new Date(Date.now()-1000).toISOString();
  const foreign=await h.harness.openCase('demo-taras');const foreignCustomer=(await h.store.customerBySession('demo-taras'))!;
  const other=await h.store.createProposal({caseId:foreign.id,tool:'external_action',args:{...proposal.args,caseId:foreign.id,customerId:foreignCustomer.id,ownershipVersion:foreign.ownershipVersion,expiresAt:new Date(Date.now()-1000).toISOString()},argsHash:randomUUID(),risk:'high',status:'pending',policy:proposal.policy});
  await assert.rejects(h.harness.customerCase('invalid-session',caseId),(error:unknown)=>error instanceof HarnessError&&error.status===401);
  await assert.rejects(h.harness.customerCase('demo-taras',caseId),(error:unknown)=>error instanceof HarnessError&&error.status===404);
  assert.equal((await h.store.proposal(proposal.id))!.status,'pending');assert.equal((await h.store.proposal(other.id))!.status,'pending');
  const refreshed=await h.harness.customerCase(OLENA,caseId);assert.equal(refreshed.supportCase.status,'escalated');assert.equal(refreshed.supportCase.ownership,'staff');assert.equal((await h.store.proposal(proposal.id))!.status,'expired');assert.match(refreshed.messages.at(-1)!.body,/Строк погодження/);assert.equal((await h.store.proposal(other.id))!.status,'pending');
  const count=refreshed.messages.length;assert.equal((await h.harness.customerCase(OLENA,caseId)).messages.length,count);
});


async function billingToolReply(result:unknown,proof=false,reply='Your recorded balance is 37542.17 UAH.'){
  const store=new MemorySupportStore(seedData());
  const integrations:BusinessIntegrations={forContext:context=>({tools:[],callTool:async()=>{if(proof)context.rememberRead?.();if(result instanceof Error)throw result;return result;}})};
  const model=new ScriptedModel(async context=>{if(result!==undefined)await context.callBusinessTool!('bank','get_balance',{}).catch(()=>undefined);return decision({intent:'billing_question',reply});});
  const harness=new SupportHarness({store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000,integrations});
  const supportCase=await harness.openCase(OLENA);const turn=await harness.runTurn(OLENA,supportCase.id,'What is my account balance?');
  assert.equal((await store.refunds()).length,0);assert.equal((await store.proposals(supportCase.id)).length,0);return turn.reply!.body;
}

test('billing reply uses trusted successful business read proof, never raw result statuses or failed calls',async()=>{
  const reply='Your recorded balance is 37542.17 UAH.';
  assert.equal(await billingToolReply({balance_cents:3754217,currency:'UAH'},true),reply);
  for(const result of [undefined,{balance_cents:3754217,currency:'UAH'},{status:'executed',data:{balance_cents:3754217}}, {status:'denied',reasonCode:'forbidden'}, {status:'failed',reasonCode:'unavailable'}, {status:'unknown',actionId:'untrusted'}, {status:'awaiting_approval',proposalId:'untrusted'},new Error('upstream unavailable')])assert.notEqual(await billingToolReply(result),reply);
  // Even a callback preceding a failed call cannot establish a completed read.
  assert.notEqual(await billingToolReply(new Error('failed after read marker'),true),reply);
});

test('successful read grounding never permits model claims that it executed a write or refund',async()=>{
  for(const reply of ['We have refunded your money successfully.','I updated your delivery address.','Your order was refunded yesterday.'])assert.notEqual(await billingToolReply({balance_cents:3754217,currency:'UAH'},true,reply),reply);
});
