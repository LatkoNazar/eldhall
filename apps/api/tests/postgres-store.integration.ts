import { fallbackCheckpoint } from '../src/modules/support/requests/rules.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { argsHash, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, type AgentContext } from '../src/modules/agent/model.js';
import { processSupportTurn, publishPendingTurns } from '../src/modules/support/turn-processor.js';
import { migrateSupport } from '../src/modules/support/migrations.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { PostgresSupportStore } from '../src/modules/support/postgres-store.js';
import { seedData } from '../src/modules/support/seed.js';
import { classificationConfigSchema } from '../src/modules/agent/classification.js';
import { ScriptedModel } from '../src/modules/agent/model.js';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import type { BusinessIntegrations } from '../src/integrations/mcp.js';
import { VersionConflict } from '../src/modules/support/store.js';
import type { GuardRule } from '../src/modules/support/guards.js';
import { InsightsRepository } from '../src/modules/insights/repository.js';

test('real PostgreSQL support persistence, claims, recovery and source revocation', {timeout:60000}, async t=>{
  const connection={host:process.env.TEST_POSTGRES_HOST??process.env.POSTGRES_HOST??'127.0.0.1',port:Number(process.env.TEST_POSTGRES_PORT??process.env.POSTGRES_PORT??5432),database:process.env.TEST_POSTGRES_DB??process.env.POSTGRES_DB??'app',user:process.env.TEST_POSTGRES_USER??process.env.POSTGRES_USER??'app',password:process.env.TEST_POSTGRES_PASSWORD??process.env.POSTGRES_PASSWORD??'development-only',connectionTimeoutMillis:3000};
  const schema='support_test_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool(connection);
  let pool:pg.Pool|undefined;
  try{
    await admin.query('CREATE SCHEMA '+schema);
    pool=new pg.Pool({...connection,options:'-c search_path='+schema,max:10});
    await migrateSupport(pool); await migrateSupport(pool);
    const store=new PostgresSupportStore(pool); await store.seedIfEmpty(seedData());
    const provider=new SimulatedPaymentProvider();
    const harness=new SupportHarness({store,provider,model:new RulesModel(),fallback:new RulesModel(),timeoutMs:1000});
    await t.test('seed does not reset persisted conversations; approvals do not execute',async()=>{
      const c=await harness.openCase('demo-olena');
      await store.seedIfEmpty(seedData());
      assert.equal((await store.getCase(c.id))?.id,c.id);
      const turn=await harness.runTurn('demo-olena',c.id,'charged twice');
      const p=turn.proposal!;
      await harness.approve(p.id,'staff',p.argsHash);
      assert.equal((await store.refunds()).length,0);
      const results=await Promise.allSettled([harness.executeApproved(p.id,'staff',p.argsHash),harness.executeApproved(p.id,'staff',p.argsHash)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal((await store.refunds()).length,1);
      assert.equal((await store.payment(String(p.args.payment_id)))?.status,'refunded');
      assert.equal((await store.auditEvents(c.id)).some(e=>e.type==='action.executed'),true);
      assert.equal((await store.getCase(c.id))?.createdAt.endsWith('Z'),true);
      assert.deepEqual((await store.runs(c.id))[0]?.toolCalls,[]);
    });
    await t.test('one payment claim across separate cases dispatches one refund',async()=>{
      await store.reset(seedData());
      let dispatches=0;
      const h=new SupportHarness({store,model:new RulesModel(),fallback:new RulesModel(),provider:{refund:async()=>{dispatches++;return {providerRef:'SIM-CROSS-CASE',simulated:true};}},timeoutMs:1000});
      const cases=await Promise.all([h.openCase('demo-olena'),h.openCase('demo-olena')]);
      const first=(await h.runTurn('demo-olena',cases[0]!.id,'charged twice')).proposal!;
      assert.equal(first.status,'pending');
      // Model the race where both requests passed the pre-insert policy check. The storage
      // reservation must still dispatch only once, independently of scheduling the turn reads.
      const second=await store.createProposal({caseId:cases[1]!.id,tool:first.tool,args:first.args,argsHash:argsHash(cases[1]!.id,first.tool,first.args),risk:first.risk,status:'pending',policy:first.policy});
      const proposals=[first,second];
      await Promise.all(proposals.map(proposal=>h.approve(proposal.id,'staff',proposal.argsHash)));
      await Promise.allSettled(proposals.map(proposal=>h.executeApproved(proposal.id,'staff',proposal.argsHash)));
      assert.equal(dispatches,1);assert.equal((await store.refunds()).length,1);
    });
    await t.test('external action: concurrent execute dispatches once; auto claim works for external_action only',async()=>{
      await store.reset(seedData());
      let dispatches=0;
      const integrations:BusinessIntegrations={forContext:ctx=>({
        tools:[{integrationId:'orders',name:'cancel_order',description:'Cancel order',inputSchema:{type:'object' as const,properties:{},additionalProperties:false as const}}],
        callTool:async(_i:string,_n:string,input:Record<string,unknown>)=>ctx.propose!({mode:'ask',title:'Cancel order',args:{integrationId:'orders',operationKey:'POST /orders/{order_id}/cancel',title:'Cancel order',toolName:'cancel_order',policyRevision:1,businessId:ctx.businessId,customerId:ctx.customerId,caseId:ctx.caseId,ownershipVersion:ctx.ownershipVersion,effect:'write',managed:false,connectionRevision:'1',manifestHash:'a'.repeat(64),operationHash:'b'.repeat(64),tags:['Orders'],guard:{id:'orders.cancel_before_shipment',status:'pending'},policySource:'group',matchedRuleIds:['orders'],expiresAt:new Date(Date.now()+900000).toISOString(),input}}),
        executeAction:async()=>{await ctx.assertActive();await ctx.markDispatched?.();dispatches++;await new Promise(resolve=>setTimeout(resolve,50));return {status:'executed' as const,data:{status:'cancelled'}};},
      })};
      const model=new ScriptedModel(async ctx=>{await ctx.callBusinessTool!('orders','cancel_order',{order_id:'ORD-1001'});return {intent:'other',summary:'s',reasoning:'r',sentiment:{label:'calm',urgency:'low'},reply:'',action:null};});
      const h=new SupportHarness({store,model,fallback:new RulesModel(),provider,timeoutMs:1000,integrations});
      const c=await h.openCase('demo-olena');
      await h.runTurn('demo-olena',c.id,'cancel my order');
      const p=(await store.proposals(c.id)).find(row=>row.tool==='external_action')!;
      assert.equal(p.status,'pending');
      await h.approve(p.id,'staff',p.argsHash);
      const results=await Promise.allSettled([h.executeApproved(p.id,'staff',p.argsHash),h.executeApproved(p.id,'staff',p.argsHash),h.executeApproved(p.id,'staff',p.argsHash)]);
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.equal(dispatches,1);
      assert.equal((await store.proposal(p.id))?.status,'executed');
      // pending -> executing without a human is allowed for external_action (policy auto) but never for refunds.
      const asked=await store.createProposal({caseId:c.id,tool:'external_action',args:{...p.args,input:{order_id:'ORD-1002'}},argsHash:'d'.repeat(64),risk:'high',status:'pending',policy:p.policy});
      assert.equal(await store.claimProposal(asked.id,asked.argsHash,'executing','agent:auto'),null); // recorded as ask: operator only
      const auto=await store.createProposal({caseId:c.id,tool:'external_action',args:{...p.args,input:{order_id:'ORD-1003'}},argsHash:'b'.repeat(64),risk:'high',status:'pending',policy:{...p.policy,requiresApproval:false}});
      assert.equal((await store.claimProposal(auto.id,auto.argsHash,'executing','agent:auto'))?.status,'executing');
      const refund=await store.createProposal({caseId:c.id,tool:'refund_payment',args:{payment_id:'x'},argsHash:'c'.repeat(64),risk:'high',status:'pending',policy:{...p.policy,requiresApproval:false}});
      assert.equal(await store.claimProposal(refund.id,refund.argsHash,'executing','agent:auto'),null);
    });
    await t.test('knowledge history survives restart, preserves access metadata and resets cleanly',async()=>{
      const business=(await store.businessesList())[0]!;
      const id=randomUUID();
      const draft=await store.saveKnowledge({id,businessId:business.id,title:'Private guide',category:'Support',content:'Internal plan guide',version:1,status:'draft',audience:'internal',plans:['Premium monthly'],sourceUrl:'https://example.test/help',updatedAt:new Date().toISOString()});
      await store.saveKnowledge({...draft,status:'published',version:2},1);
      await migrateSupport(pool!);
      const fresh=new PostgresSupportStore(pool!);
      const versions=await fresh.knowledgeVersions(business.id,id);
      assert.deepEqual(versions.map(v=>[v.version,v.status]),[[2,'published'],[1,'draft']]);
      assert.ok(versions.every(v=>v.audience==='internal'&&v.plans?.[0]==='Premium monthly'&&v.sourceUrl==='https://example.test/help'));
      const other=(await fresh.businessesList()).find(b=>b.id!==business.id)!;
      assert.deepEqual(await fresh.knowledgeVersions(other.id,id),[]);
      await store.reset(seedData());
      assert.deepEqual(await fresh.knowledgeVersions(business.id,id),[]);
    });
    await t.test('external citations persist separately from local UUID source references',async()=>{
      const c=await store.createCase(seedData().customers[0]!.businessId,seedData().customers[0]!.id);
      const lease=(await store.acquireTurn(c.id,randomUUID()))!;
      const business=(await store.business(c.businessId))!;
      const refs=[{connectorId:'company-kb',pointId:42,contentHash:'a'.repeat(64)}];
      const completed=await store.completeTurn(lease,{},'Remote answer',[],{policy:business.policy,skills:[],externalSourceRefs:refs});
      assert.ok(completed);
      const fresh=new PostgresSupportStore(pool!);
      assert.deepEqual((await fresh.messages(c.id))[0]!.sourceRefs,[]);
      assert.deepEqual((await fresh.messages(c.id))[0]!.externalSourceRefs,refs);
      await store.releaseTurn(lease);
    });
    await t.test('turn exclusion, expired-run recovery and ownership fencing survive storage',async()=>{
      const c=await harness.openCase('demo-olena');
      const old=(await store.acquireTurn(c.id,randomUUID()))!;
      assert.equal(await store.acquireTurn(c.id,randomUUID()),null);
      await pool!.query("UPDATE support_cases SET active_run_at=now()-interval '181 seconds' WHERE id=$1",[c.id]);
      const reclaimed=(await store.acquireTurn(c.id,randomUUID()))!;
      assert.ok(reclaimed.ownershipVersion>old.ownershipVersion);
      assert.equal(await store.assertTurn(old),false);
      await store.setOwnership(c.id,'staff','operator:staff',reclaimed.ownershipVersion);
      assert.equal(await store.completeTurn(reclaimed,{status:'open'},'stale'),null);
      await store.staffMessage(c.id,'Human reply',reclaimed.ownershipVersion+1);
      assert.equal((await store.messages(c.id)).at(-1)?.role,'operator');
    });
    await t.test('JSON settings/skills round-trip and final commit checks document revocation',async()=>{
      const business=(await store.businessesList())[0]!;
      const current=await store.settings(business.id);
      await store.saveSettings({...current,version:2,enabledTools:['lookup_payments','escalate_to_human']},1);
      assert.deepEqual((await store.settings(business.id)).enabledTools,['lookup_payments','escalate_to_human']);
      await store.saveSkill({id:randomUUID(),businessId:business.id,name:'custom/hours',content:'Cite opening hours.',revision:1,enabled:true,updatedAt:new Date().toISOString()});
      assert.equal((await store.skills(business.id))[0]?.content,'Cite opening hours.');
      const source=await store.saveKnowledge({id:randomUUID(),businessId:business.id,title:'Opening',category:'Support',content:'Open at 9',version:1,status:'published',updatedAt:new Date().toISOString()});
      const customer=seedData().customers.find(customer=>customer.businessId===business.id)!;
      const c=await store.createCase(business.id,customer.id); const lease=(await store.acquireTurn(c.id,randomUUID()))!;
      const client=await pool!.connect();
      try{
        await client.query('BEGIN');await client.query("UPDATE support_knowledge SET version=2,status='revoked' WHERE id=$1",[source.id]);
        const completed=store.completeTurn(lease,{status:'open'},'Open at 9',[{id:source.id,version:1}]);
        await client.query('COMMIT');assert.equal(await completed,null);
      }finally{client.release();}
      assert.equal((await store.messages(c.id)).length,0);
    });
    await t.test('queued turns survive store restart, expired worker claims and repeated delivery without duplicate input or proposals',async()=>{
      await store.reset(seedData());
      const c=await harness.openCase('demo-olena');
      const accepted=await harness.enqueueTurn('demo-olena',c.id,'charged twice',randomUUID());
      assert.equal((await store.messages(c.id)).length,1);
      const restarted=new PostgresSupportStore(pool!);
      await assert.rejects(publishPendingTurns(restarted,async()=>{throw new Error('redis unavailable');}));
      assert.equal((await restarted.pendingTurnJobs())[0]?.id,accepted.job?.id);
      const simultaneous=await Promise.all([restarted.claimTurnJob(accepted.job!.id,'dead-worker'),restarted.claimTurnJob(accepted.job!.id,'other-worker')]);
      const old=simultaneous.find(Boolean)!;
      assert.equal(simultaneous.filter(Boolean).length,1);
      const args={payment_id:'00000000-0000-4000-8000-000000000202',amount_cents:49900};
      const catalog=await restarted.requestCheckpoint(old.lease,accepted.message.id,fallbackCheckpoint(await restarted.requestCatalog(c.id),accepted.message));const request=catalog.requests[0]!;
      await restarted.createProposal({caseId:c.id,tool:'refund_payment',args,argsHash:argsHash(c.id,'refund_payment',args),risk:'high',status:'pending',policy:{allowed:true,requiresApproval:true,checks:[]}},old.lease,[{id:request.id,revision:request.revision}]);
      await pool!.query("UPDATE support_turn_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[accepted.job!.id]);
      const recovered=(await restarted.claimTurnJob(accepted.job!.id,'replacement-worker'))!;
      assert.equal(recovered.lease.jobFence,2);
      assert.equal(await restarted.completeTurn(old.lease,{status:'open'},'stale worker output'),null);
      const contexts:AgentContext[]=[];const rules=new RulesModel();
      const recovering=new SupportHarness({store:restarted,provider,model:{provider:'rules',model:'recovery-rules',decide:async(ctx)=>{contexts.push(ctx);return rules.decide(ctx);}},fallback:rules,timeoutMs:1000});
      await recovering.runQueued(recovered.job,recovered.lease);
      await processSupportTurn(accepted.job!.id,'duplicate-delivery',restarted,recovering);
      assert.equal(contexts[0]?.runtimeAttempt,2);
      assert.equal((await restarted.messages(c.id)).filter(message=>message.role==='customer').length,1);
      assert.equal((await restarted.messages(c.id)).filter(message=>message.role==='assistant').length,1);
      assert.equal((await restarted.proposals(c.id)).length,1);
      assert.equal(await restarted.activeTurnJob(c.id),null);
    });
    await t.test('concurrent skill CAS has one winner and completion fences exact enabled skills and settings', async () => {
      await store.reset(seedData());
      const customer = seedData().customers[0]!;
      const skill = await store.saveSkill({ id: randomUUID(), businessId: customer.businessId, name: 'custom/pg-procedure', content: 'Original procedure.', revision: 1, enabled: true, updatedAt: new Date().toISOString() });
      const disabled = await store.saveSkill({ ...skill, id: randomUUID(), name: 'custom/pg-newly-enabled', content: 'Initially disabled procedure.', enabled: false });
      const competing = await Promise.allSettled(['First reviewed procedure.', 'Second reviewed procedure.'].map(content => new PostgresSupportStore(pool!).saveSkill({ ...skill, content, revision: 2 }, 1)));
      const winner = competing.find(result => result.status === 'fulfilled');
      const loser = competing.find(result => result.status === 'rejected');
      assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(winner?.status === 'fulfilled'); assert.ok(loser?.status === 'rejected');
      assert.ok(loser.reason instanceof VersionConflict);
      const restarted = new PostgresSupportStore(pool!);
      assert.deepEqual((await restarted.skills(customer.businessId)).find(row => row.id === skill.id), winner.value);
      const c = await restarted.createCase(customer.businessId, customer.id);
      const lease = (await restarted.acquireTurn(c.id, randomUUID()))!;
      const snapshot = async () => ({ policy: (await restarted.business(customer.businessId))!.policy, settingsVersion: (await restarted.settings(customer.businessId)).version, classification: (await restarted.settings(customer.businessId)).classification, skills: (await restarted.skills(customer.businessId)).filter(row => row.enabled).map(({ id, revision }) => ({ id, revision })) });
      const current = await snapshot();
      assert.equal(await restarted.completeTurn(lease, {}, 'Stale skill response', [], { ...current, skills: [{ id: skill.id, revision: 1 }] }), null);
      await restarted.saveSkill({ ...disabled, enabled: true, revision: 2 }, 1);
      assert.equal(await restarted.completeTurn(lease, {}, 'Missing newly enabled instructions', [], current), null);
      const beforeSettingsChange = await snapshot();
      const settings = await restarted.settings(customer.businessId);
      await restarted.saveSettings({ ...settings, language: 'en', version: settings.version + 1 }, settings.version);
      assert.deepEqual((await restarted.business(customer.businessId))!.policy, beforeSettingsChange.policy);
      assert.equal(await restarted.completeTurn(lease, {}, 'Stale response preferences', [], beforeSettingsChange), null);
      assert.equal((await restarted.messages(c.id)).length, 0);
      const completed = await restarted.completeTurn(lease, {}, 'Current instructions and preferences', [], await snapshot());
      assert.equal(completed?.reply.body, 'Current instructions and preferences');
      assert.equal((await restarted.messages(c.id)).length, 1);
      await restarted.releaseTurn(lease);
    });
    await t.test('the current stored guard blocks an old approved refund until restored and dispatches exactly once', async () => {
      await store.reset(seedData());
      let dispatches = 0;
      const businessId = seedData().customers[0]!.businessId;
      const refundProvider = { refund: async () => { dispatches++; return { providerRef: 'SIM-PG-CURRENT-GUARD', simulated: true as const }; } };
      const h = new SupportHarness({ store, model: new RulesModel(), fallback: new RulesModel(), provider: refundProvider, workspaceBusinessId: businessId, timeoutMs: 1000 });
      const c = await h.openCase('demo-olena');
      const proposal = (await h.runTurn('demo-olena', c.id, 'charged twice')).proposal!;
      await h.approve(proposal.id, 'staff', proposal.argsHash);
      assert.equal((await store.proposal(proposal.id))?.policy.allowed, true);
      const deny: GuardRule = { id: randomUUID(), name: 'Temporary refund restriction', definitionVersion: 1, enabled: true, kind: 'deny_action', target: { tool: 'refund_payment' }, reason: 'Operator review of refund procedure is in progress.' };
      const settings = await store.settings(businessId);
      await store.saveSettings({ ...settings, guards: [deny], guardRevision: 1, version: settings.version + 1 }, settings.version);
      const restarted = new PostgresSupportStore(pool!);
      const restartedHarness = new SupportHarness({ store: restarted, model: new RulesModel(), fallback: new RulesModel(), provider: refundProvider, workspaceBusinessId: businessId, timeoutMs: 1000 });
      assert.equal((await restarted.settings(businessId)).guardRevision, 1);
      await assert.rejects(restartedHarness.executeApproved(proposal.id, 'staff', proposal.argsHash), { status: 409 });
      assert.equal((await restarted.proposal(proposal.id))?.status, 'approved');
      assert.equal(dispatches, 0); assert.equal((await restarted.refunds()).length, 0);
      assert.ok((await restarted.auditEvents(c.id)).some(event => event.type === 'guard.evaluated' && event.data.guardRevision === 1 && event.data.allowed === false));
      const blockedSettings = await restarted.settings(businessId);
      await restarted.saveSettings({ ...blockedSettings, guards: [{ ...deny, enabled: false }], guardRevision: 2, version: blockedSettings.version + 1 }, blockedSettings.version);
      const executions = await Promise.allSettled([restartedHarness.executeApproved(proposal.id, 'staff', proposal.argsHash), restartedHarness.executeApproved(proposal.id, 'staff', proposal.argsHash)]);
      assert.equal(executions.filter(result => result.status === 'fulfilled').length, 1);
      await assert.rejects(restartedHarness.executeApproved(proposal.id, 'staff', proposal.argsHash), { status: 409 });
      assert.equal(dispatches, 1);
      assert.equal((await restarted.refunds()).length, 1);
      assert.equal((await restarted.refunds())[0]?.amountCents, 49900);
      assert.equal((await restarted.proposal(proposal.id))?.status, 'executed');
      assert.equal((await restarted.settings(businessId)).requireApproval, true);
    });
    await t.test('scoped pending, claims and recovery leave eligible foreign support and Insights rows byte-equivalent', async () => {
      await store.reset(seedData());
      const [ownBusiness, foreignBusiness] = seedData().businesses;
      assert.ok(ownBusiness && foreignBusiness);
      const ownCase = await harness.openCase('demo-olena'), foreignCase = await harness.openCase('demo-marta');
      const own = await harness.enqueueTurn('demo-olena', ownCase.id, 'Hello from the bound workspace');
      const foreign = await harness.enqueueTurn('demo-marta', foreignCase.id, 'Foreign queued customer request');
      assert.ok(own.job && foreign.job);
      assert.ok(await store.claimTurnJob(foreign.job.id, 'foreign-worker', foreignBusiness.id));
      await pool!.query("UPDATE support_turn_jobs SET attempts=3,lease_expires_at=now()-interval '1 second' WHERE id=$1", [foreign.job.id]);
      const interruptedProposal = async (caseId: string, customerId: string) => {
        const payment = seedData().payments.find(row => row.customerId === customerId)!;
        const args = { payment_id: payment.id, amount_cents: payment.amountCents };
        return store.createProposal({ caseId, tool: 'refund_payment', args, argsHash: argsHash(caseId, 'refund_payment', args), risk: 'high', status: 'executing', policy: { allowed: true, requiresApproval: true, checks: [] } });
      };
      const ownProposal = await interruptedProposal(ownCase.id, ownCase.customerId), foreignProposal = await interruptedProposal(foreignCase.id, foreignCase.customerId);
      await pool!.query("UPDATE support_proposals SET decided_at=now()-interval '181 seconds' WHERE id=ANY($1::uuid[])", [[ownProposal.id, foreignProposal.id]]);
      const insights = new InsightsRepository(pool!);
      const foreignInsight = await insights.create(foreignBusiness.id, 5, randomUUID(), 'fixture', 'no-model-call');
      const ownInsight = await insights.create(ownBusiness.id, 5, randomUUID(), 'fixture', 'no-model-call');
      await pool!.query("UPDATE support_insight_runs SET status='running',attempts=3,lease_owner='foreign-worker',lease_expires_at=now()-interval '1 second' WHERE id=$1", [foreignInsight.id]);
      const foreignState = async () => ({
        job: (await pool!.query('SELECT to_jsonb(j) AS row FROM support_turn_jobs j WHERE id=$1', [foreign.job!.id])).rows,
        supportCase: (await pool!.query('SELECT to_jsonb(c) AS row FROM support_cases c WHERE id=$1', [foreignCase.id])).rows,
        proposal: (await pool!.query('SELECT to_jsonb(p) AS row FROM support_proposals p WHERE id=$1', [foreignProposal.id])).rows,
        messages: (await pool!.query('SELECT to_jsonb(m) AS row FROM support_messages m WHERE case_id=$1 ORDER BY id', [foreignCase.id])).rows,
        audit: (await pool!.query('SELECT to_jsonb(a) AS row FROM support_audit_events a WHERE case_id=$1 ORDER BY id', [foreignCase.id])).rows,
        insight: (await pool!.query('SELECT to_jsonb(i) AS row FROM support_insight_runs i WHERE id=$1', [foreignInsight.id])).rows,
      });
      const before = await foreignState();
      assert.deepEqual((await store.pendingTurnJobs(50, foreignBusiness.id)).map(job => job.id), [foreign.job.id]);
      assert.deepEqual((await store.pendingTurnJobs(50, ownBusiness.id)).map(job => job.id), [own.job.id]);
      assert.equal(await store.claimTurnJob(foreign.job.id, 'bound-worker', ownBusiness.id), null);
      const published: string[] = [];
      assert.equal(await publishPendingTurns(store, async id => { published.push(id); }, ownBusiness.id), 1);
      assert.deepEqual(published, [own.job.id]);
      let modelCalls = 0;
      const rules = new RulesModel();
      const scoped = new SupportHarness({ store, provider, workspaceBusinessId: ownBusiness.id, model: { provider: 'rules', model: 'scoped-pg-fixture', decide: async ctx => { modelCalls++; assert.equal(ctx.businessId, ownBusiness.id); return rules.decide(ctx); } }, fallback: rules, timeoutMs: 1000 });
      await processSupportTurn(foreign.job.id, 'bound-worker', store, scoped);
      assert.equal(modelCalls, 0);
      await store.recoverInterruptedExecutions(ownBusiness.id);
      assert.equal((await store.proposal(ownProposal.id))?.status, 'unknown');
      assert.equal((await store.proposal(foreignProposal.id))?.status, 'executing');
      await processSupportTurn(own.job.id, 'bound-worker', store, scoped);
      assert.equal(modelCalls, 1);
      assert.equal((await pool!.query('SELECT status FROM support_turn_jobs WHERE id=$1', [own.job.id])).rows[0]?.status, 'completed');
      const insightClaim = await insights.claim('bound-insight-worker', ownBusiness.id);
      assert.equal(insightClaim?.id, ownInsight.id);
      assert.equal(insightClaim?.businessId, ownBusiness.id);
      assert.equal(await insights.claim('bound-insight-worker', ownBusiness.id), null);
      assert.deepEqual(await foreignState(), before);
    });
    await t.test('classification survives a store restart and atomic completion rejects a concurrent taxonomy change', async () => {
      await store.reset(seedData());
      const business = seedData().businesses[0]!;
      const current = await store.settings(business.id);
      const classification = classificationConfigSchema.parse({ revision: 1, fallbackClassId: 'other', classes: [
        { id: '1', label: 'Invoices', description: 'Invoice questions.' },
        { id: 'other', label: 'Other', description: 'Unmatched or uncertain questions.' },
      ] });
      await store.saveSettings({ ...current, version: current.version + 1, classification }, current.version);
      const restarted = new PostgresSupportStore(pool!);
      assert.deepEqual((await restarted.settings(business.id)).classification, classification);
      const custom = new SupportHarness({ store: restarted, provider, fallback: new RulesModel(), timeoutMs: 1000,
        model: new ScriptedModel(() => ({ intent: 'billing_question', summary: 'Invoice question', reasoning: 'The customer asks about an invoice.', sentiment: { label: 'calm', urgency: 'low' }, reply: 'Please share the invoice reference.', action: null,
          classification: { classId: '1', confidence: 0.95, reason: 'An invoice is requested.' } })) });
      const supportCase = await custom.openCase('demo-olena');
      await custom.runTurn('demo-olena', supportCase.id, 'Where is my invoice?');
      const persisted = await new PostgresSupportStore(pool!).getCase(supportCase.id);
      assert.equal(persisted?.analysis?.classification?.classId, '1');
      assert.equal(persisted?.analysis?.classification?.revision, 1);
      const raced = await custom.openCase('demo-olena');
      const lease = (await restarted.acquireTurn(raced.id, randomUUID()))!;
      const snapshot = await restarted.settings(business.id);
      const client = await pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE support_businesses SET name=name WHERE id=$1', [business.id]);
        await client.query('UPDATE support_settings SET version=version+1,classification=$2 WHERE business_id=$1', [business.id, JSON.stringify({ ...classification, revision: 2 })]);
        const completed = restarted.completeTurn(lease, { status: 'open' }, 'stale classifier response', [], { policy: business.policy, skills: [], classification: snapshot.classification });
        await client.query('COMMIT');
        assert.equal(await completed, null);
      } finally { client.release(); }
      assert.equal((await restarted.messages(raced.id)).length, 0);
      assert.equal((await restarted.getCase(supportCase.id))?.analysis?.classification?.label, 'Invoices');
    });
    await t.test('disabled classifier watermark survives store restart and stale bootstrap without blocking normal turns', async () => {
      await store.reset(seedData());
      const business = seedData().businesses[0]!;
      const taxonomy = classificationConfigSchema.parse({ revision: 5, fallbackClassId: 'other', classes: [
        { id: '1', label: 'Invoices', description: 'Invoice questions.' },
        { id: 'other', label: 'Other', description: 'Uncertain questions.' },
      ] });
      const current = await store.settings(business.id);
      const enabled = await store.saveSettings({ ...current, classification: taxonomy, version: current.version + 1 }, current.version);
      await store.saveSettings({ ...enabled, classification: null, version: enabled.version + 1 }, enabled.version);
      const restarted = new PostgresSupportStore(pool!);
      for (const revision of [1, 5]) await bootstrapSupportConfig(restarted, supportConfigSchema.parse({ classifications: [{ ...taxonomy, businessId: business.id, revision }] }));
      assert.equal((await restarted.settings(business.id)).classification, null);
      assert.deepEqual(await restarted.classificationState(business.id), { revision: 5, disabled: true });
      assert.equal(JSON.stringify(await restarted.settings(business.id)).includes('disabled'), false);
      const rules = new RulesModel();
      const plain = new SupportHarness({ store: restarted, provider, model: rules, fallback: rules, timeoutMs: 1000 });
      const supportCase = await plain.openCase('demo-olena');
      await plain.runTurn('demo-olena', supportCase.id, 'Hello');
      assert.equal((await restarted.messages(supportCase.id)).filter(message => message.role === 'assistant').length, 1);
      assert.equal((await restarted.getCase(supportCase.id))?.analysis?.classification, null);
      await bootstrapSupportConfig(restarted, supportConfigSchema.parse({ classifications: [{ ...taxonomy, businessId: business.id, revision: 6 }] }));
      assert.equal((await new PostgresSupportStore(pool!).settings(business.id)).classification?.revision, 6);
    });
    await t.test('repeated worker crashes exhaust a bounded recovery budget',async()=>{
      const c=await harness.openCase('demo-olena');
      const accepted=await harness.enqueueTurn('demo-olena',c.id,'hello');
      for(let attempt=1;attempt<=3;attempt++) {
        const claim=await store.claimTurnJob(accepted.job!.id,'worker-'+attempt);
        assert.equal(claim?.job.attempts,attempt);
        await pool!.query("UPDATE support_turn_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[accepted.job!.id]);
      }
      assert.equal(await store.claimTurnJob(accepted.job!.id,'worker-four'),null);
      assert.equal(await store.activeTurnJob(c.id),null);
      const result=await pool!.query('SELECT status,attempts FROM support_turn_jobs WHERE id=$1',[accepted.job!.id]);
      assert.equal(result.rows[0].status,'failed');assert.equal(result.rows[0].attempts,3);
      assert.equal((await store.messages(c.id)).filter(message=>message.role==='system').length,1);
    });
    await t.test('test cases and their agent runs, actions and refunds stay out of ordinary metrics',async()=>{
      const data=seedData();
      await store.reset(data);
      const demo=data.customers[0]!;
      const testCase=await store.createCase(demo.businessId,demo.id,'test');
      const liveCase=await store.createCase(demo.businessId,demo.id);
      const payment=data.payments[1]!;
      const proposal=await store.createProposal({caseId:testCase.id,tool:'refund_payment',args:{},argsHash:'a'.repeat(64),risk:'high',status:'executed',policy:{allowed:true,requiresApproval:true,checks:[]}});
      await store.recordRefund({paymentId:payment.id,proposalId:proposal.id,amountCents:payment.amountCents,providerRef:'SIM-TEST'});
      await store.recordRun({caseId:testCase.id,provider:'fixture',model:'fixture',status:'fallback',steps:1,toolCalls:[],latencyMs:100,error:null});
      await store.recordRun({caseId:liveCase.id,provider:'fixture',model:'fixture',status:'ok',steps:1,toolCalls:[],latencyMs:20,error:null});
      assert.deepEqual((await store.listCases(undefined,'test')).map(({id,isTest})=>[id,isTest]),[[testCase.id,true]]);
      assert.deepEqual((await store.listCases(undefined,'live')).map(({id,isTest})=>[id,isTest]),[[liveCase.id,false]]);
      const metrics=await store.metrics(demo.businessId);
      assert.equal(metrics.cases,1);
      assert.equal(metrics.agentRuns,1);
      assert.equal(metrics.fallbackRuns,0);
      assert.equal(metrics.avgAgentLatencyMs,20);
      assert.equal(metrics.proposals.executed,0);
      assert.equal(metrics.refundsIssuedCents,0);
    });
  }finally{
    await pool?.end();
    // Only this randomly named test schema is removed; public application data is untouched.
    await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');
    await admin.end();
  }
});
