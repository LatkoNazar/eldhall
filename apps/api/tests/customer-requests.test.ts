import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { argsHash, SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore, StaleTurn, VersionConflict, type SupportStore } from '../src/modules/support/store.js';
import { supportRoutes } from '../src/modules/support/routes.js';
import type { RequestCheckpoint } from '../src/modules/support/requests/contracts.js';
import { fallbackCheckpoint } from '../src/modules/support/requests/rules.js';

export async function requestFixture(store: SupportStore = new MemorySupportStore(seedData())) {
  const seed=seedData(); await store.seedIfEmpty(seed);
  const supportCase=await store.createCase(seed.businesses[0]!.id,seed.customers[0]!.id);
  const message=await store.addMessage(supportCase.id,'customer','Змініть адресу. Доставку перенесіть після уточнення адреси. Поверніть повторне списання. Надішліть рахунок.');
  const lease=(await store.acquireTurn(supportCase.id,randomUUID()))!;
  return {store,supportCase,message,lease};
}
const change=(source:string, title='Goal'): RequestCheckpoint['changes'][number]=>({localKey:'goal',title,goal:title,waitingOn:null,nextStep:null,sourceMessageIds:[source],dependencyIds:[],dependencyKeys:[]});
const proposal=(caseId:string)=>({caseId,tool:'refund_payment',args:{payment_id:seedData().payments[1]!.id,amount_cents:49900},argsHash:argsHash(caseId,'refund_payment',{payment_id:seedData().payments[1]!.id,amount_cents:49900}),risk:'high' as const,status:'pending' as const,policy:{allowed:true,requiresApproval:true,checks:[]}});

test('four local requests persist stable IDs, revision history and exact checkpoint replay',async()=>{
  const f=await requestFixture(); const batch=fallbackCheckpoint(await f.store.requestCatalog(f.supportCase.id),f.message);
  const first=await f.store.requestCheckpoint(f.lease,f.message.id,batch);
  assert.equal(first.requests.length,4); assert.equal(first.requests[1]!.dependencyIds[0],first.requests[0]!.id);
  assert.deepEqual(await f.store.requestCheckpoint(f.lease,f.message.id,batch),first);
  await assert.rejects(f.store.requestCheckpoint(f.lease,f.message.id,{...batch,syncState:'needs_review'}),VersionConflict);
  const clarification=await f.store.addMessage(f.supportCase.id,'customer','Уточню адресу: Лісова, 12, під’їзд 2; квартиру надішлю пізніше.');
  const next=await f.store.requestCheckpoint(f.lease,clarification.id,fallbackCheckpoint(first,clarification));
  assert.equal(next.requests.length,4); assert.equal(next.requests[0]!.id,first.requests[0]!.id); assert.equal(next.requests[0]!.revision,2);
  assert.equal(next.requests[0]!.waitingOn,'customer'); assert.equal(next.history.events.some(event=>event.requestId===first.requests[0]!.id&&event.revision===1),true);
});

test('source-only updates preserve approval; material changes invalidate it without changing arguments',async()=>{
  const f=await requestFixture(); let catalog=await f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[change(f.message.id)]});
  const row=catalog.requests[0]!; const p=await f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:1}]);
  assert.ok(await f.store.decideProposal(p.id,p.argsHash,'approved','operator:test'));
  const source=await f.store.addMessage(f.supportCase.id,'customer','Same goal, another citation'); catalog=await f.store.requestCatalog(f.supportCase.id);
  catalog=await f.store.requestCheckpoint(f.lease,source.id,{version:catalog.version,syncState:'current',changes:[{...change(source.id),id:row.id,expectedRevision:1}]});
  assert.equal(catalog.requests[0]!.revision,1); assert.equal((await f.store.proposal(p.id))!.status,'approved');
  const newSource=await f.store.addMessage(f.supportCase.id,'customer','Changed goal');
  await f.store.requestCheckpoint(f.lease,newSource.id,{version:catalog.version,syncState:'current',changes:[{...change(newSource.id,'Different goal'),id:row.id,expectedRevision:1}]});
  const invalidated=(await f.store.proposal(p.id))!; assert.equal(invalidated.status,'invalidated'); assert.equal(invalidated.argsHash,p.argsHash);assert.deepEqual(invalidated.args,p.args);
  assert.equal(await f.store.claimExecution(p.id,p.argsHash,'operator:test'),null);
});

test('same-case sources, DAG, CAS and takeover are enforced without partial catalog mutation',async()=>{
  const f=await requestFixture(); const foreign=await f.store.createCase(seedData().businesses[0]!.id,seedData().customers[0]!.id);const source=await f.store.addMessage(foreign.id,'customer','foreign');
  await assert.rejects(f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[{...change(f.message.id),sourceMessageIds:[f.message.id,source.id]}]}));
  await assert.rejects(f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[{...change(f.message.id),dependencyKeys:['goal']}]}));
  assert.equal((await f.store.requestCatalog(f.supportCase.id)).version,0);
  const batch={version:0,syncState:'current' as const,changes:[change(f.message.id)]}; const outcomes=await Promise.allSettled([f.store.requestCheckpoint(f.lease,f.message.id,batch),f.store.requestCheckpoint(f.lease,f.message.id,{...batch,changes:[change(f.message.id,'Other')]})]);
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  await f.store.setOwnership(f.supportCase.id,'staff','operator:test');
  await assert.rejects(f.store.requestCheckpoint(f.lease,source.id,batch),StaleTurn);
});

test('unknown old-revision effect blocks a newly linked action and operator closure',async()=>{
  const f=await requestFixture(); let catalog=await f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[change(f.message.id)]}); const row=catalog.requests[0]!;
  const p=await f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:1}]);
  await f.store.decideProposal(p.id,p.argsHash,'approved','operator:test'); await f.store.claimExecution(p.id,p.argsHash,'operator:test');await f.store.finishProposal(p.id,'unknown',null,'Unconfirmed');
  const source=await f.store.addMessage(f.supportCase.id,'customer','New goal');catalog=await f.store.requestCatalog(f.supportCase.id);
  await f.store.requestCheckpoint(f.lease,source.id,{version:catalog.version,syncState:'current',changes:[{...change(source.id,'New goal'),id:row.id,expectedRevision:1}]});
  const second=await f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:2}]);
  assert.equal(await f.store.decideProposal(second.id,second.argsHash,'approved','operator:test'),null);
  catalog=await f.store.requestCatalog(f.supportCase.id);
  await assert.rejects(f.store.requestTransition(f.supportCase.id,row.id,{version:catalog.version,revision:2,transition:'cancel',reason:'Cannot bypass unknown effect',proof:{messageIds:[],proposalIds:[]}},'operator:test'),VersionConflict);
  assert.equal((await f.store.proposal(p.id))!.status,'unknown');
});

test('executed effects do not fulfill requests; explicit evidenced CAS does, with one winner',async()=>{
  const f=await requestFixture();const first=await f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[change(f.message.id)]});const row=first.requests[0]!;
  const p=await f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:1}]);await f.store.finishProposal(p.id,'executed',{providerRef:'SYNTHETIC'},null);
  const catalog=await f.store.requestCatalog(f.supportCase.id);assert.equal(catalog.requests[0]!.lifecycle,'open');
  const body={version:catalog.version,revision:1,transition:'fulfill' as const,reason:'Operator verified recorded receipt',proof:{proposalIds:[p.id],messageIds:[]}};
  const outcomes=await Promise.allSettled([f.store.requestTransition(f.supportCase.id,row.id,body,'operator:test'),f.store.requestTransition(f.supportCase.id,row.id,body,'operator:test')]);assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await f.store.requestCatalog(f.supportCase.id)).requests[0]!.lifecycle,'fulfilled');
});

test('operator request transitions keep staff authentication and reject fabricated completion evidence',async()=>{
  const f=await requestFixture();const catalog=await f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[change(f.message.id)]});
  const app=Fastify();const model=new RulesModel();const harness=new SupportHarness({store:f.store,model,fallback:model,provider:new SimulatedPaymentProvider(),timeoutMs:1000});
  await app.register(supportRoutes,{support:{store:f.store,harness},operatorToken:'synthetic-operator',demoResetEnabled:false});
  try { const url='/api/v1/cases/'+f.supportCase.id+'/requests/'+catalog.requests[0]!.id+'/transition';const body={version:catalog.version,revision:1,transition:'fulfill',reason:'No proof',proof:{proposalIds:[],messageIds:[]}};
    assert.equal((await app.inject({method:'POST',url,payload:body})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url,headers:{authorization:'Bearer synthetic-operator'},payload:body})).statusCode,422);
  } finally {await app.close();}
});

test('rules and legacy scripted turns checkpoint real sources before proposals and never invent a completed request',async()=>{
  const store=new MemorySupportStore(seedData());const rules=new RulesModel();const harness=new SupportHarness({store,model:rules,fallback:rules,provider:new SimulatedPaymentProvider(),timeoutMs:1000});
  const c=await harness.openCase('demo-olena');const turn=await harness.runTurn('demo-olena',c.id,'Змініть адресу. Перенесіть доставку. Поверніть повторне списання двічі. Надішліть рахунок.');
  const catalog=(await harness.detail(c.id)).requestCatalog;assert.equal(catalog.requests.length,4);assert.ok(turn.proposal);assert.equal(catalog.requests.every(row=>row.lifecycle==='open'),true);assert.equal(catalog.requests.find(row=>row.title.includes('списання'))!.actions[0]!.proposalId,turn.proposal.id);
  const unknown=await harness.openCase('demo-taras');await harness.runTurn('demo-taras',unknown.id,'Something unusual happened');assert.equal((await store.requestCatalog(unknown.id)).syncState,'needs_review');assert.equal((await store.requestCatalog(unknown.id)).requests.length,1);
});

test('native-protocol model cannot submit or dispatch without checkpoint; fallback records honest review state',async()=>{
  const store=new MemorySupportStore(seedData());let dispatched=0;const model:AgentModel={requestCatalogProtocol:'checkpoint-v1',provider:'scripted',model:'protocol',decide:async ctx=>{assert.equal(ctx.requestCheckpointAccepted?.(),false);await assert.rejects(ctx.callBusinessTool!('test','write',{}));return {decision:{intent:'other',summary:'s',reasoning:'r',sentiment:{label:'calm',urgency:'low'},reply:'r',action:null},steps:1,toolCalls:[]};}};
  const fallback=new RulesModel();const harness=new SupportHarness({store,model,fallback,provider:new SimulatedPaymentProvider(),timeoutMs:1000,integrations:{forContext:()=>({tools:[],callTool:async()=>{dispatched++;return {};}})}});
  const c=await harness.openCase('demo-taras');await assert.rejects(harness.runTurn('demo-taras',c.id,'unparsed'));assert.equal(dispatched,0);
  const scripted=new ScriptedModel(()=>{throw Error('synthetic failure');});const safe=new SupportHarness({store,model:scripted,fallback,provider:new SimulatedPaymentProvider(),timeoutMs:1000});const other=await safe.openCase('demo-taras');await safe.runTurn('demo-taras',other.id,'unparsed');assert.equal((await store.requestCatalog(other.id)).syncState,'needs_review');
});

test('unknown and mixed requests are honest review records; acknowledgements add no fake task and handoff stays available',async()=>{
  const store=new MemorySupportStore(seedData());const rules=new RulesModel();const harness=new SupportHarness({store,model:rules,fallback:rules,provider:new SimulatedPaymentProvider(),timeoutMs:1000});
  const c=await harness.openCase('demo-taras');await harness.runTurn('demo-taras',c.id,'Please update my tax residence');let catalog=await store.requestCatalog(c.id);
  assert.equal(catalog.requests.length,1);assert.equal(catalog.syncState,'needs_review');assert.equal(catalog.requests[0]!.goal,'Please update my tax residence');const id=catalog.requests[0]!.id;
  await harness.runTurn('demo-taras',c.id,'Please update my tax residence');catalog=await store.requestCatalog(c.id);assert.equal(catalog.requests.length,1);assert.equal(catalog.requests[0]!.id,id);
  const hello=await harness.openCase('demo-taras');await harness.runTurn('demo-taras',hello.id,'Hello');assert.equal((await store.requestCatalog(hello.id)).requests.length,0);
  const cancel=await harness.openCase('demo-taras');const result=await harness.runTurn('demo-taras',cancel.id,'Cancel my subscription. Адресу надішлю пізніше.');
  const cancelledCatalog=await store.requestCatalog(cancel.id);assert.equal(cancelledCatalog.requests.length,2);assert.equal(result.proposal!.tool,'escalate_to_human');assert.equal(result.proposal!.status,'executed');assert.equal(cancelledCatalog.requests.every(row=>row.actions.some(link=>link.proposalId===result.proposal!.id)),true);
  assert.equal(cancelledCatalog.requests.some(row=>row.waitingOn==='customer'),true);assert.equal(cancelledCatalog.requests.every(row=>row.lifecycle==='open'),true);
});

test('original customer ask is not fulfillment proof; current receipt is returned after replay, and empty checkpoints cannot write',async()=>{
  const f=await requestFixture();const batch={version:0,syncState:'current' as const,changes:[change(f.message.id)]};let catalog=await f.store.requestCheckpoint(f.lease,f.message.id,batch);const row=catalog.requests[0]!;
  await assert.rejects(f.store.requestTransition(f.supportCase.id,row.id,{version:catalog.version,revision:1,transition:'fulfill',reason:'This is only the original ask',proof:{proposalIds:[],messageIds:[f.message.id]}},'operator:test'));
  const linked=await f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:1}]);catalog=await f.store.requestCatalog(f.supportCase.id);
  assert.equal((await f.store.requestCheckpoint(f.lease,f.message.id,batch)).version,catalog.version);assert.equal((await f.store.requestCheckpoint(f.lease,f.message.id,batch)).requests[0]!.actions[0]!.proposalId,linked.id);
  const source=await f.store.addMessage(f.supportCase.id,'customer','A different unparsed goal');await assert.rejects(f.store.requestCheckpoint(f.lease,source.id,{version:catalog.version,syncState:'current',changes:[]}));
  await f.store.requestCheckpoint(f.lease,source.id,{version:catalog.version,syncState:'needs_review',changes:[]});
  await assert.rejects(f.store.createProposal(proposal(f.supportCase.id),f.lease,[]));await assert.rejects(f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:1}]));
});

test('fallback does not invent apartment requirements or delivery dependencies from co-occurrence',async()=>{
  const f=await requestFixture();const source=await f.store.addMessage(f.supportCase.id,'customer','Змініть адресу на Лісову 12. Доставку перенесіть на 8 листопада.');const catalog=await f.store.requestCheckpoint(f.lease,source.id,fallbackCheckpoint(await f.store.requestCatalog(f.supportCase.id),source));
  assert.equal(catalog.requests.length,2);assert.equal(catalog.requests[0]!.waitingOn,null);assert.deepEqual(catalog.requests[1]!.dependencyIds,[]);
});

test('non-Latin requests and numeric clarifications are not silently treated as acknowledgements',async()=>{
  const f=await requestFixture();for(const body of ['请更新我的地址','يرجى تعديل حجزي','12345']) {
    const source=await f.store.addMessage(f.supportCase.id,'customer',body);const before=await f.store.requestCatalog(f.supportCase.id);
    await assert.rejects(f.store.requestCheckpoint(f.lease,source.id,{version:before.version,syncState:'current',changes:[]}));
    const next=await f.store.requestCheckpoint(f.lease,source.id,fallbackCheckpoint(before,source));assert.equal(next.syncState,'needs_review');assert.equal(next.requests.some(row=>row.goal===body),true);
  }
});

test('one executed refund cannot resolve four open goals; failed explicit resolve is atomic, final closure and reopening aggregate',async()=>{
  const f=await requestFixture();const first=await f.store.requestCheckpoint(f.lease,f.message.id,fallbackCheckpoint(await f.store.requestCatalog(f.supportCase.id),f.message));const row=first.requests.find(row=>row.title.includes('списання'))!;
  const p=await f.store.createProposal(proposal(f.supportCase.id),f.lease,[{id:row.id,revision:1}]);const before=(await f.store.getCase(f.supportCase.id))!;
  await assert.rejects(f.store.resolveCase(f.supportCase.id,'operator:test',before.ownershipVersion),VersionConflict);assert.deepEqual(await f.store.getCase(f.supportCase.id),before);assert.equal((await f.store.proposal(p.id))!.status,'pending');assert.equal(await f.store.assertTurn(f.lease),true);
  const rules=new RulesModel();const harness=new SupportHarness({store:f.store,model:rules,fallback:rules,provider:new SimulatedPaymentProvider(),timeoutMs:1000});await harness.approve(p.id,'test',p.argsHash);await harness.executeApproved(p.id,'test',p.argsHash);
  assert.notEqual((await f.store.getCase(f.supportCase.id))!.status,'resolved');assert.equal((await f.store.requestCatalog(f.supportCase.id)).requests.filter(row=>row.lifecycle==='open').length,4);
  for(const request of first.requests){const current=await f.store.requestCatalog(f.supportCase.id);await f.store.requestTransition(f.supportCase.id,request.id,{version:current.version,revision:request.revision,transition:'cancel',reason:'Operator explicitly closes this synthetic request',proof:{proposalIds:[],messageIds:[]}},'operator:test');}
  assert.equal((await f.store.getCase(f.supportCase.id))!.status,'resolved');const closed=await f.store.requestCatalog(f.supportCase.id);const target=closed.requests[0]!;
  await f.store.requestTransition(f.supportCase.id,target.id,{version:closed.version,revision:target.revision,transition:'reopen',reason:'Customer still needs help',proof:{proposalIds:[],messageIds:[]}},'operator:test');assert.notEqual((await f.store.getCase(f.supportCase.id))!.status,'resolved');
});

test('history reads have an honest bound without dropping current goals or their stable IDs',async()=>{
  const f=await requestFixture();let catalog=await f.store.requestCatalog(f.supportCase.id);let ids:string[]=[];
  for(let iteration=0;iteration<11;iteration++){
    const source=iteration===0?f.message:await f.store.addMessage(f.supportCase.id,'customer','Additional evidence '+iteration);
    catalog=await f.store.requestCheckpoint(f.lease,source.id,{version:catalog.version,syncState:'current',changes:Array.from({length:10},(_,index)=>({...change(source.id,'Goal '+index),localKey:'goal'+index,...(ids[index]?{id:ids[index],expectedRevision:1}:{})}))});
    ids=catalog.requests.map(row=>row.id);
  }
  assert.equal(catalog.requests.length,10);assert.equal(catalog.history.events.length,100);assert.equal(catalog.history.hasMore,true);assert.equal(catalog.requests.every(row=>row.revision===1),true);
});

test('a new staff-owned ask reopens the tracked ticket without running a model; thanks cannot hide it',async()=>{
  const f=await requestFixture();const catalog=await f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[change(f.message.id)]});const row=catalog.requests[0]!;
  await f.store.requestTransition(f.supportCase.id,row.id,{version:catalog.version,revision:1,transition:'cancel',reason:'Explicitly closed by operator',proof:{proposalIds:[],messageIds:[]}},'operator:test');
  await f.store.releaseTurn(f.lease);await f.store.resolveCase(f.supportCase.id,'operator:test');const before=(await f.store.getCase(f.supportCase.id))!;
  const model=new ScriptedModel(()=>{throw Error('Must not run while staff owns ticket');});const harness=new SupportHarness({store:f.store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:1000});
  const result=await harness.runTurn('demo-olena',f.supportCase.id,'A new issue needs help');assert.equal(result.case.status,'escalated');assert.equal(result.case.ownershipVersion,before.ownershipVersion);assert.equal(model.calls,0);
  await f.store.addMessage(f.supportCase.id,'customer','Thanks');assert.equal((await f.store.requestCatalog(f.supportCase.id)).syncState,'needs_review');assert.notEqual((await f.store.getCase(f.supportCase.id))!.status,'resolved');
});

test('novel same-title fallback merges explicitly need review instead of claiming semantic identity',async()=>{
  const f=await requestFixture();const a=await f.store.addMessage(f.supportCase.id,'customer','Refund payment A');const first=await f.store.requestCheckpoint(f.lease,a.id,fallbackCheckpoint(await f.store.requestCatalog(f.supportCase.id),a));
  const b=await f.store.addMessage(f.supportCase.id,'customer','Refund payment B');const batch=fallbackCheckpoint(first,b);assert.equal(batch.syncState,'needs_review');
  const next=await f.store.requestCheckpoint(f.lease,b.id,batch);assert.equal(next.requests[0]!.id,first.requests[0]!.id);assert.equal(next.syncState,'needs_review');
});

test('a validated later customer confirmation can fulfill the last goal without trapping the ticket in review',async()=>{
  const f=await requestFixture();const first=await f.store.requestCheckpoint(f.lease,f.message.id,{version:0,syncState:'current',changes:[change(f.message.id)]});const row=first.requests[0]!;
  const confirmation=await f.store.addMessage(f.supportCase.id,'customer','I received the correction and the requested goal is satisfied');assert.equal((await f.store.requestCatalog(f.supportCase.id)).syncState,'needs_review');
  const closed=await f.store.requestTransition(f.supportCase.id,row.id,{version:first.version,revision:1,transition:'fulfill',reason:'Operator verified the later customer confirmation',proof:{proposalIds:[],messageIds:[confirmation.id]}},'operator:test');
  assert.equal(closed.requests[0]!.lifecycle,'fulfilled');assert.equal(closed.syncState,'current');assert.equal((await f.store.getCase(f.supportCase.id))!.status,'resolved');
});
