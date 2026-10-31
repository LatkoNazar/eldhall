import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { HarnessError, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision, type AgentModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider, type PaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const decision:AgentDecision={intent:'other',summary:'summary',reasoning:'reason',sentiment:{label:'calm',urgency:'low'},reply:'Hello',action:null};
const setup=(model:AgentModel=new RulesModel(),provider:PaymentProvider=new SimulatedPaymentProvider())=>{
  const store=new MemorySupportStore(seedData());
  return {store,harness:new SupportHarness({store,model,fallback:new RulesModel(),provider,timeoutMs:200})};
};
test('approval is separate from execution; concurrent executions dispatch exactly once',async()=>{
  const h=setup(); const c=await h.harness.openCase('demo-olena');
  const turn=await h.harness.runTurn('demo-olena',c.id,'charged twice');
  const p=turn.proposal!;
  await h.harness.approve(p.id,'staff',p.argsHash);
  assert.equal((await h.store.refunds()).length,0);
  const results=await Promise.allSettled([h.harness.executeApproved(p.id,'staff',p.argsHash),h.harness.executeApproved(p.id,'staff',p.argsHash)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await h.store.refunds()).length,1);
});
test('payment reservation prevents concurrent refunds proposed in separate cases',async()=>{
  let dispatches=0;
  const provider:PaymentProvider={refund:async()=>{dispatches++; return {providerRef:'SIM-ONE',simulated:true};}};
  const h=setup(new RulesModel(),provider);
  const cases=await Promise.all([h.harness.openCase('demo-olena'),h.harness.openCase('demo-olena')]);
  const turns=await Promise.all(cases.map(c=>h.harness.runTurn('demo-olena',c.id,'charged twice')));
  await Promise.all(turns.map(t=>h.harness.approve(t.proposal!.id,'staff',t.proposal!.argsHash)));
  await Promise.allSettled(turns.map(t=>h.harness.executeApproved(t.proposal!.id,'staff',t.proposal!.argsHash)));
  assert.equal(dispatches,1); assert.equal((await h.store.refunds()).length,1);
});
test('ambiguous provider result is unknown and cannot be retried',async()=>{
  let dispatches=0;
  const h=setup(new RulesModel(),{refund:async()=>{dispatches++; throw new Error('response lost after dispatch');}});
  const c=await h.harness.openCase('demo-olena'); const t=await h.harness.runTurn('demo-olena',c.id,'charged twice'); const p=t.proposal!;
  await h.harness.approve(p.id,'staff',p.argsHash);
  assert.equal((await h.harness.executeApproved(p.id,'staff',p.argsHash)).proposal.status,'unknown');
  await assert.rejects(h.harness.executeApproved(p.id,'staff',p.argsHash),(e:HarnessError)=>e.status===409);
  assert.equal(dispatches,1);
});
test('expired approval never dispatches and stale settings updates are refused',async()=>{
  const h=setup();const c=await h.harness.openCase('demo-olena');const turn=await h.harness.runTurn('demo-olena',c.id,'charged twice');const p=turn.proposal!;
  await h.harness.approve(p.id,'staff',p.argsHash);
  h.store.proposalRows.get(p.id)!.decidedAt=new Date(Date.now()-16*60*1000).toISOString();
  await assert.rejects(h.harness.executeApproved(p.id,'staff',p.argsHash),(e:HarnessError)=>e.status===409);
  assert.equal((await h.store.refunds()).length,0);
  const current=await h.store.settings(c.businessId);
  const results=await Promise.allSettled([h.store.saveSettings({...current,version:2},1),h.store.saveSettings({...current,version:2},1)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
});
test('one turn per conversation and takeover fences stale final output',async()=>{
  let finish:(value:AgentDecision)=>void=()=>undefined;
  const model=new ScriptedModel(()=>new Promise<AgentDecision>(resolve=>{finish=resolve;}));
  const h=setup(model); const c=await h.harness.openCase('demo-olena');
  const first=h.harness.runTurn('demo-olena',c.id,'hello');
  // Wait for the model boundary without arbitrary wall-clock sleeps.
  while(!model.calls) await new Promise<void>(resolve=>setImmediate(resolve));
  await assert.rejects(h.harness.runTurn('demo-olena',c.id,'second'),(e:HarnessError)=>e.status===409);
  await h.store.setOwnership(c.id,'staff','operator:staff');
  finish(decision);
  await assert.rejects(first,(e:HarnessError)=>e.status===409);
  assert.equal((await h.store.messages(c.id)).filter(m=>m.role==='assistant').length,0);
  const routed=await h.harness.runTurn('demo-olena',c.id,'need a human');
  assert.equal(routed.reply,null); assert.equal(model.calls,1);
  await h.store.staffMessage(c.id,'I can help',1);
  assert.equal((await h.store.messages(c.id)).at(-1)?.role,'operator');
});
test('revoked knowledge fences in-flight output and cross-business retrieval is excluded',async()=>{
  let finish:(value:AgentDecision)=>void=()=>undefined;
  const model=new ScriptedModel(ctx=>new Promise<AgentDecision>(resolve=>{assert.equal(ctx.knowledge.length,1);finish=resolve;}));
  const h=setup(model); const customer=(await h.store.customerBySession('demo-olena'))!;
  const source=await h.store.saveKnowledge({id:'00000000-0000-4000-8000-000000000999',businessId:customer.businessId,title:'Hours',category:'Support',content:'We open at 9.',version:1,status:'published',updatedAt:new Date().toISOString()});
  const c=await h.harness.openCase('demo-olena'); const run=h.harness.runTurn('demo-olena',c.id,'hours');
  while(!model.calls) await new Promise<void>(resolve=>setImmediate(resolve));
  await h.store.saveKnowledge({...source,version:2,status:'revoked'},1); finish(decision);
  await assert.rejects(run,(e:HarnessError)=>e.status===409);
  assert.equal((await h.store.messages(c.id)).filter(m=>m.role==='assistant').length,0);
});
test('headless APIs scope documents, enforce versions, trim input and use trusted operator identity',async()=>{
  const h=setup();
  const app=await createApp(settingsFrom({API_TOKEN:'t',OPERATOR_TOKEN:'operator-token'}),{store:{} as never,dispatch:async()=>undefined,checks:{},support:{harness:h.harness,store:h.store}});
  const headers={host:'testserver',authorization:'Bearer operator-token'};
  try {
    const businesses=(await app.inject({url:'/api/v1/businesses',headers})).json().businesses;
    const provisioned=await app.inject({method:'POST',url:'/api/v1/businesses',headers,payload:{name:'Real business',slug:'real-business',currency:'UAH'}});
    assert.equal(provisioned.statusCode,201,provisioned.body);
    const customer=await app.inject({method:'POST',url:'/api/v1/customers',headers,payload:{businessId:provisioned.json().id,name:'Customer',email:'customer@example.invalid',plan:'standard'}});
    assert.equal(customer.statusCode,201,customer.body);assert.ok(customer.json().sessionToken.length>=40);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/chat/cases',headers:{host:'testserver','x-customer-session':customer.json().sessionToken}})).statusCode,201);
    const businessId=businesses[0].id;
    const created=await app.inject({method:'POST',url:'/api/v1/knowledge?businessId='+businessId,headers,payload:{title:' Hours ',category:'Support',content:'Open at 9'}});
    assert.equal(created.statusCode,201,created.body); const source=created.json(); assert.equal(source.title,'Hours');
    assert.equal((await app.inject({method:'POST',url:'/api/v1/knowledge/'+source.id+'/publish?businessId='+businessId,headers,payload:{version:1}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/knowledge/'+source.id+'/revoke?businessId='+businessId,headers,payload:{version:1}})).statusCode,409);
    if(businesses[1]) assert.equal((await app.inject({url:'/api/v1/knowledge?businessId='+businesses[1].id,headers})).json().sources.length,0);
    assert.equal((await app.inject({method:'POST',url:'/api/v1/knowledge',headers:{host:'testserver','x-customer-session':'demo-olena'},payload:{title:'bad',category:'x',content:'y'}})).statusCode,401);
    const opened=(await app.inject({method:'POST',url:'/api/v1/chat/cases',headers:{host:'testserver','x-customer-session':'demo-olena'}})).json();
    const empty=await app.inject({method:'POST',url:'/api/v1/chat/cases/'+opened.id+'/messages',headers:{host:'testserver','x-customer-session':'demo-olena'},payload:{body:'   '}});
    assert.equal(empty.statusCode,422);
    const turn=await app.inject({method:'POST',url:'/api/v1/chat/cases/'+opened.id+'/messages',headers:{host:'testserver','x-customer-session':'demo-olena'},payload:{body:'charged twice'}});
    assert.equal(turn.statusCode,200,turn.body);
    const proposal=(await app.inject({url:'/api/v1/cases/'+opened.id,headers})).json().proposals[0];
    const approved=await app.inject({method:'POST',url:'/api/v1/proposals/'+proposal.id+'/approve',headers,payload:{operator:'forged-admin',argsHash:proposal.argsHash}});
    assert.equal(approved.statusCode,200,approved.body); assert.equal(approved.json().proposal.decidedBy,'operator:staff');
    const settings=(await app.inject({url:'/api/v1/settings?businessId='+businessId,headers})).json();
    const {businessId:ignored,...body}=settings; void ignored;
    assert.equal((await app.inject({method:'PATCH',url:'/api/v1/settings?businessId='+businessId,headers,payload:{...body,requireApproval:false}})).statusCode,422);
  }finally{await app.close();}
});
test('document revocation hides derived assistant history from a future run and customer history',async()=>{
  const h=setup();const c=await h.harness.openCase('demo-olena');
  const source=await h.store.saveKnowledge({id:'00000000-0000-4000-8000-000000000998',businessId:c.businessId,title:'Hours',category:'Support',content:'Hours: open at 9',version:1,status:'published',updatedAt:new Date().toISOString()});
  const result=await h.harness.runTurn('demo-olena',c.id,'hours');assert.match(result.reply!.body,/open at 9/);
  await h.store.saveKnowledge({...source,status:'revoked',version:2},1);
  const customer=await h.harness.customerCase('demo-olena',c.id);
  assert.doesNotMatch(customer.messages.filter(message=>message.role==='assistant').map(message=>message.body).join(' '),/open at 9/);
});
test('model prose never supplies a financial success without an executed backend action',async()=>{
  for (const intent of ['refund_request','other'] as const) {
    for (const reply of ['Your refund is complete. I have refunded you.','Повернення завершено. Кошти повернено.']) {
      const h=setup(new ScriptedModel(()=>({...decision,intent,reply,action:null})));
      const c=await h.harness.openCase('demo-olena');
      const result=await h.harness.runTurn('demo-olena',c.id,'refund please');
      assert.notEqual(result.reply?.body,reply);assert.equal((await h.store.refunds()).length,0);
      assert.doesNotMatch(result.reply!.body,/refund is complete|I have refunded|Повернення завершено|Кошти повернено/);
    }
  }
});
