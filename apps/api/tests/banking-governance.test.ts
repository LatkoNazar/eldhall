import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import pg from 'pg';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { seedData } from '../src/modules/support/seed.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { supportRoutes } from '../src/modules/support/routes.js';
import { activity, activityFromAudit, safeToolFacts, safeToolResult } from '../src/modules/support/activity.js';
import type { AuditEvent } from '../src/modules/support/contracts.js';
import { evaluateGuards, type GuardRule } from '../src/modules/support/guards.js';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { processSupportTurn, publishPendingTurns } from '../src/modules/support/turn-processor.js';
import { insightsRoutes } from '../src/modules/insights/routes.js';
import { InsightsRepository } from '../src/modules/insights/repository.js';
import { InsightsService } from '../src/modules/insights/service.js';

const A=seedData().businesses[0]!.id,B=seedData().businesses[1]!.id;
const headers={authorization:'Bearer synthetic-bank-key'};
const answer:AgentDecision={intent:'other',summary:'A public factual summary',reasoning:'A short public justification',reply:'Please clarify',sentiment:{label:'calm',urgency:'low'},action:null};
const rule=(maxAmountCents=10000):GuardRule=>({id:'b2000000-0000-4000-8000-000000000001',name:'Additional refund ceiling',definitionVersion:1,enabled:true,target:{tool:'refund_payment'},reason:'Bank refund ceiling',kind:'amount_limit',maxAmountCents,currency:'UAH'});
async function fixture(model=new RulesModel() as RulesModel|ScriptedModel){
  const store=new MemorySupportStore(seedData());const harness=new SupportHarness({workspaceBusinessId:A,store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000});
  const app=Fastify();await app.register(supportRoutes,{support:{workspaceBusinessId:A,store,harness},operatorToken:'synthetic-bank-key',demoResetEnabled:true});return {app,store,harness};
}

test('fixed workspace filters all support resources and refuses global reset without changing foreign records',async()=>{
  const f=await fixture();try{
    const bank=await f.store.createCase(A,seedData().customers[0]!.id);const foreign=await f.store.createCase(B,seedData().customers[3]!.id);await f.store.addMessage(foreign.id,'customer','Historical foreign business data');
    const p=await f.store.createProposal({caseId:foreign.id,tool:'external_action',args:{},argsHash:'a'.repeat(64),risk:'high',status:'pending',policy:{allowed:true,requiresApproval:true,checks:[]}});
    const before=await f.store.messages(foreign.id);assert.equal((await f.app.inject({url:'/api/v1/workspace'})).statusCode,401);
    assert.equal((await f.app.inject({url:'/api/v1/workspace',headers})).json().business.id,A);
    assert.deepEqual((await f.app.inject({url:'/api/v1/businesses',headers})).json().businesses.map((row:{id:string})=>row.id),[A]);
    assert.deepEqual((await f.app.inject({url:'/api/v1/cases',headers})).json().map((row:{id:string})=>row.id),[bank.id]);assert.equal((await f.app.inject({url:'/api/v1/metrics',headers})).json().cases,1);
    for(const url of ['/cases/'+foreign.id,'/skills?businessId='+B,'/settings?businessId='+B,'/knowledge?businessId='+B,'/integrations?businessId='+B])assert.equal((await f.app.inject({url:'/api/v1'+url,headers})).statusCode,404,url);
    for(const action of ['approve','execute','reject','reconcile'])assert.equal((await f.app.inject({method:'POST',url:'/api/v1/proposals/'+p.id+'/'+action,headers,payload:action==='approve'||action==='execute'?{argsHash:p.argsHash}:action==='reject'?{reason:'Operator action'}:{reason:'Operator action',status:'failed'}})).statusCode===404,true,action);
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/demo/reset',headers})).statusCode,409);assert.deepEqual(await f.store.messages(foreign.id),before);assert.equal((await f.store.businessesList()).length,2);assert.equal((await f.store.proposal(p.id))!.status,'pending');
    assert.equal((await f.app.inject({method:'POST',url:'/api/v1/chat/cases',headers:{'x-customer-session':'demo-marta'}})).statusCode,401);
  }finally{await f.app.close();}
});

test('workspace ambiguity is explicit and internal harness/worker paths never send foreign context to a model',async()=>{
  const store=new MemorySupportStore(seedData());const model=new ScriptedModel(()=>answer);const harness=new SupportHarness({workspaceBusinessId:A,store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000});
  const c=await store.createCase(B,seedData().customers[3]!.id);const accepted=await store.enqueueTurn(c.id,seedData().customers[3]!.id,'Historical foreign question',randomUUID());const before=await store.activeTurnJob(c.id);
  await processSupportTurn(accepted.job!.id,'bank-worker',store,harness);assert.deepEqual(await store.activeTurnJob(c.id),before);assert.equal(model.calls,0);
  const published:string[]=[];await publishPendingTurns(store,async id=>{published.push(id);},A);assert.deepEqual(published,[]);
  await assert.rejects(harness.runTurn('demo-marta',c.id,'Read old data'),/Unknown customer session/);await assert.rejects(harness.detail(c.id),/Case not found/);assert.equal(model.calls,0);
  const app=Fastify();await app.register(supportRoutes,{support:{store,harness:new SupportHarness({store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000})},operatorToken:'synthetic-bank-key',demoResetEnabled:false});try{const response=await app.inject({url:'/api/v1/workspace',headers});assert.equal(response.statusCode,409);assert.equal(response.json().code,'workspace_ambiguous');}finally{await app.close();}
});

test('skill updates and guard policy edits use CAS and bootstrap revisions without erasing existing data',async()=>{
  const f=await fixture();try{
    const created=(await f.app.inject({method:'POST',url:'/api/v1/skills?businessId='+A,headers,payload:{name:'custom/banking-demo',content:'Never request a PIN or OTP',enabled:true}})).json();assert.equal(created.revision,1);
    const patched=await f.app.inject({method:'PATCH',url:'/api/v1/skills/'+created.id+'?businessId='+A,headers,payload:{revision:1,content:'Only backend-verified duplicate charges may be proposed',enabled:true}});assert.equal(patched.statusCode,200);assert.equal(patched.json().revision,2);
    assert.equal((await f.app.inject({method:'PATCH',url:'/api/v1/skills/'+created.id+'?businessId='+A,headers,payload:{revision:1,content:'stale',enabled:false}})).statusCode,409);
    const first=await f.app.inject({method:'PUT',url:'/api/v1/guards?businessId='+A,headers,payload:{version:1,rules:[rule()]}});assert.equal(first.statusCode,200);assert.equal(first.json().revision,1);
    assert.equal((await f.app.inject({method:'PUT',url:'/api/v1/guards?businessId='+A,headers,payload:{version:1,rules:[]}})).statusCode,409);
    const settings=await f.store.settings(A);await f.store.saveSettings({...settings,version:settings.version+1,tone:'neutral',guards:undefined,guardRevision:undefined},settings.version);assert.deepEqual((await f.store.settings(A)).guards,[rule()]);
    await bootstrapSupportConfig(f.store,supportConfigSchema.parse({guardPolicies:[{businessId:A,revision:2,guards:[rule(20000)]}]}));assert.equal((await f.store.settings(A)).guardRevision,2);
    await bootstrapSupportConfig(f.store,supportConfigSchema.parse({guardPolicies:[{businessId:A,revision:1,guards:[]}]}));assert.equal((await f.store.settings(A)).guards![0]!.kind,'amount_limit');
    await assert.rejects(bootstrapSupportConfig(f.store,supportConfigSchema.parse({guardPolicies:[{businessId:A,revision:2,guards:[]}]})),/new revision/);assert.equal((await f.store.businessesList()).length,2);
  }finally{await f.app.close();}
});

test('declarative guards cannot weaken refund policy and current guard edits stop previously approved execution',async()=>{
  const f=await fixture();try{
    const c=await f.harness.openCase('demo-olena');const turn=await f.harness.runTurn('demo-olena',c.id,'charged twice');const p=turn.proposal!;await f.harness.approve(p.id,'test',p.argsHash);
    const settings=await f.store.settings(A);await f.store.saveSettings({...settings,version:settings.version+1,guardRevision:1,guards:[rule(10000)]},settings.version);
    await assert.rejects(f.harness.executeApproved(p.id,'test',p.argsHash));assert.equal((await f.store.refunds()).length,0);const detail=await f.harness.detail(c.id);assert.equal(detail.agentActivity.events.some(event=>event.type==='guard'&&event.outcome==='denied'&&event.context?.guardRevision===1),true);
    const current=await f.store.settings(A);await f.store.saveSettings({...current,version:current.version+1,guardRevision:2,guards:[rule(100000)]},current.version);const executed=await f.harness.executeApproved(p.id,'test',p.argsHash);assert.equal(executed.proposal.status,'executed');assert.equal((await f.store.refunds()).length,1);
    assert.equal(evaluateGuards('refund_payment',{amount_cents:1},[{kind:'run_javascript',code:'allow()'}],'UAH').allowed,false);
  }finally{await f.app.close();}
});

test('newly enabled skills and changed settings fence a running turn before business dispatch',async()=>{
  for(const change of ['skill','guard'] as const){
    let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const wait=new Promise<void>(resolve=>{release=resolve;});let dispatched=0;
    const store=new MemorySupportStore(seedData());const model=new ScriptedModel(async ctx=>{entered();await wait;await ctx.callBusinessTool!('fixture','read',{});return answer;});
    const harness=new SupportHarness({workspaceBusinessId:A,store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000,integrations:{forContext:()=>({tools:[],callTool:async()=>{dispatched++;return {};}})}});const c=await harness.openCase('demo-olena');const running=harness.runTurn('demo-olena',c.id,'Hello');await ready;
    if(change==='skill')await store.saveSkill({id:randomUUID(),businessId:A,name:'custom/new-live-rule',content:'Updated procedure',revision:1,enabled:true,updatedAt:new Date().toISOString()});
    else{const settings=await store.settings(A);await store.saveSettings({...settings,version:settings.version+1,guards:[rule()],guardRevision:1},settings.version);}
    release();await assert.rejects(running);assert.equal(dispatched,0);assert.equal((await store.proposals(c.id)).length,0);
  }
});

test('activity records exact delivered skill hashes and safe facts without hidden reasoning or arbitrary secret payloads',async()=>{
  const f=await fixture();try{
    const skill={id:randomUUID(),businessId:A,name:'custom/context-proof',content:'A short banking procedure',revision:1,enabled:true,updatedAt:new Date().toISOString()};await f.store.saveSkill(skill);
    const c=await f.harness.openCase('demo-olena');await f.harness.runTurn('demo-olena',c.id,'Hello');const detail=await f.harness.detail(c.id);const context=detail.agentActivity.events.find(event=>event.type==='context')!;
    assert.equal(context.context!.skills[0]!.revision,1);assert.match(context.context!.skills[0]!.contentHash,/^[a-f0-9]{64}$/);assert.equal(context.runId,detail.runs[0]!.id);
    const facts=safeToolResult({payments:[{id:randomUUID(),amountCents:10000,currency:'UAH',status:'captured',apiKey:'private-value'}],sources:[{id:randomUUID(),title:'Published procedure',version:1,content:'private-document-body'}],apiKey:'private-value'});
    assert.equal(facts.payment1AmountCents,10000);assert.equal(facts.source1Title,'Published procedure');assert.doesNotMatch(JSON.stringify(facts),/private-value|private-document-body|thoughtSignature/);
    assert.doesNotMatch(JSON.stringify(safeToolFacts('call_business_tool',{integrationId:'bank',name:'read',input:{password:'private-value'}})),/private-value/);
  }finally{await f.app.close();}
});

test('bound Insights routes reject foreign runs before repository or model work',async()=>{
  const pool=new pg.Pool({host:'127.0.0.1',port:1,database:'unused',user:'unused',password:'unused',options:''});let queries=0;
  const guarded=new Proxy(pool,{get(target,key){if(key==='query')return()=>{queries++;throw Error('Database access forbidden in this scope test');};return Reflect.get(target,key,target);}});
  const app=Fastify();await app.register(insightsRoutes,{prefix:'/api/v1/insights',insights:new InsightsService(new InsightsRepository(guarded),undefined,1000,A),operatorToken:'synthetic-bank-key',workspaceBusinessId:A});
  try{for(const url of ['/api/v1/insights/runs?businessId='+B,'/api/v1/insights/runs/'+randomUUID()+'?businessId='+B])assert.equal((await app.inject({url,headers})).statusCode,404);assert.equal((await app.inject({method:'POST',url:'/api/v1/insights/runs',headers,payload:{businessId:B}})).statusCode,404);assert.equal(queries,0);}finally{await app.close();await pool.end();}
});


test('safe tool facts respect the public total budget for ten payments and mixed result shapes',()=>{
  const payments=Array.from({length:10},()=>({id:randomUUID(),amountCents:10000,currency:'UAH',status:'captured',password:'private-value'}));
  const sources=Array.from({length:10},()=>({id:randomUUID(),title:'Procedure',version:1,content:'private-value'}));
  for(const value of [{payments},{status:'executed',reasonCode:'allowed',proposalId:randomUUID(),payments,sources,requestCatalog:{requests:[{}]}}]){
    const facts=safeToolResult(value);assert.ok(Object.keys(facts).length<=40);assert.equal(facts.paymentsCount,10);assert.equal(facts.omitted,true);assert.doesNotMatch(JSON.stringify(facts),/private-value/);
  }
});

test('merged guard admissions retain canonical request links and unique per-run sequence',()=>{
  const runId=randomUUID(),proposalId=randomUUID(),requestId=randomUUID();
  const row=(type:string,data:Record<string,unknown>):AuditEvent=>({id:randomUUID(),caseId:randomUUID(),type,actor:'system',data,createdAt:new Date().toISOString()});
  const event=(sequence:number,type:'tool_result'|'decision')=>row('agent.activity',{...activity(type,'Recorded event',{proposalId,requestIds:[requestId]}),runId,sequence,turnJobId:null});
  const result=activityFromAudit([event(1,'tool_result'),row('guard.evaluated',{proposalId,allowed:true,checks:[],guards:[],requestIds:[randomUUID()]}),event(2,'decision'),row('guard.evaluated',{proposalId,allowed:false,checks:[],guards:[]})]);
  assert.deepEqual(result.events.map(event=>event.sequence),[1,2,3,4]);
  assert.deepEqual(result.events.filter(event=>event.type==='guard').map(event=>event.requestIds),[[requestId],[requestId]]);
});

test('provider failure details never persist in public runs or fallback audit',async()=>{
  const f=await fixture(new ScriptedModel(()=>{throw Error('private-provider-value thoughtSignature confidential');}));try{
    const c=await f.harness.openCase('demo-olena');await f.harness.runTurn('demo-olena',c.id,'Hello');
    const detail=await f.harness.detail(c.id);assert.equal(detail.runs[0]!.status,'fallback');assert.equal(detail.runs[0]!.error,'agent_runtime_failure');
    assert.doesNotMatch(JSON.stringify({detail,audit:await f.store.auditEvents(c.id)}),/private-provider-value|thoughtSignature|confidential/);
  }finally{await f.app.close();}
});


test('foreign provider action identifiers remain facts rather than trusted case proposal links',async()=>{
  const foreignId=randomUUID();const f=await fixture(new ScriptedModel(async ctx=>{
    await ctx.recordActivity?.(activity('tool_result','Read completed',{proposalId:foreignId,result:safeToolResult({actionId:foreignId,status:'shipped'})}));return answer;
  }));try{
    const c=await f.harness.openCase('demo-olena');await f.harness.runTurn('demo-olena',c.id,'Hello');
    const event=(await f.harness.detail(c.id)).agentActivity.events.find(event=>event.type==='tool_result')!;
    assert.equal(event.proposalId,null);assert.equal(event.result!.proposalId,foreignId);
  }finally{await f.app.close();}
});


test('grounded billing answers reach the customer while successful knowledge reads never authorize refund claims',async()=>{
  for(const reply of ['The published card service fee is 0 UAH.','We have refunded your money successfully.']){
    const f=await fixture(new ScriptedModel(async ctx=>{const hits=await ctx.searchKnowledge('card service fee');assert.ok(hits.some(hit=>hit.title==='Published card fees'));return {...answer,intent:'billing_question',reply};}));try{
      await f.store.saveKnowledge({id:randomUUID(),businessId:A,title:'Published card fees',category:'billing',content:'# Card service fee\nThe card service fee is 0 UAH.',version:1,status:'published',audience:'customer',updatedAt:new Date().toISOString()});
      const c=await f.harness.openCase('demo-olena');const turn=await f.harness.runTurn('demo-olena',c.id,'What is the card service fee?');
      if(reply.startsWith('The published'))assert.equal(turn.reply!.body,reply);else{assert.notEqual(turn.reply!.body,reply);assert.doesNotMatch(turn.reply!.body,/refunded|successfully/);}
      assert.equal((await f.store.refunds()).length,0);assert.equal((await f.store.proposals(c.id)).length,0);
    }finally{await f.app.close();}
  }
});
