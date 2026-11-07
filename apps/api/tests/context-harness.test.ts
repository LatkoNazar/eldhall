import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { seedData } from '../src/modules/support/seed.js';

class ModernModel extends ScriptedModel {
  readonly contextProtocol='catalog-v1' as const;
  readonly requestCatalogProtocol='checkpoint-v1' as const;
}
const answer:AgentDecision={intent:'other',summary:'Request reviewed',reasoning:'No business operation was needed.',sentiment:{label:'calm',urgency:'low'},reply:'Please clarify your request.',action:null};
const seed=seedData(),customer=seed.customers[0]!;

test('modern harness supplies scoped memory and distinguishes available optional skills from delivered bodies',async()=>{
  const store=new MemorySupportStore(seed);
  const optional={id:randomUUID(),businessId:customer.businessId,name:'custom/shipping',revision:1,enabled:true,updatedAt:new Date().toISOString(),content:'---\nactivation: on_demand\ndescription: Parcel support\n---\nExact parcel procedure.'};
  await store.saveSkill(optional);
  let inventories=0;
  const model=new ModernModel(async ctx=>{
    assert.equal(ctx.contextMemory!.currentMessage.body,'Track my parcel');
    assert.equal(ctx.contextMemory!.recentMessages.some(message=>message.id===ctx.currentCustomerMessageId),false);
    assert.equal(ctx.contextCatalog!.skills.find(skill=>skill.id===optional.id)!.activation,'on_demand');
    assert.equal((await ctx.loadSupportContext!({skillIds:[optional.id]})).skills[0]!.content,'Exact parcel procedure.');
    assert.equal(inventories,1,'skill-only loads do not refresh remote tool inventories');
    await ctx.checkpointRequests!({version:ctx.requestCatalog!().version,syncState:'needs_review',changes:[]});
    return answer;
  });
  const fallback=new ScriptedModel(()=>{throw Error('Unexpected fallback');});
  const harness=new SupportHarness({store,model,fallback,timeoutMs:1000,provider:{async refund(){throw Error('Unexpected payment');}},integrations:{forContext:()=>({tools:[],listTools:async()=>{inventories++;return [];},callTool:async()=>{throw Error('Unexpected business call');}})}});
  const supportCase=await harness.openCase(customer.sessionToken);
  await harness.runTurn(customer.sessionToken,supportCase.id,'Track my parcel');
  const detail=await harness.detail(supportCase.id),context=detail.agentActivity.events.find(event=>event.type==='context')!.context!;
  assert.equal(context.availableSkills!.some(skill=>skill.id===optional.id),true);
  assert.equal(context.skills.some(skill=>skill.id===optional.id),false);
  assert.equal(model.calls,1);assert.equal(fallback.calls,0);
});

test('oversized required state preserves all goals and unknown actions and hands off without any model or financial call',async t=>{
  for(const accepted of [false,true])await t.test(accepted?'existing source checkpoint remains immutable':'unparsed source is explicitly marked for review',async()=>{
    const store=new MemorySupportStore(seed);
    const model=new ModernModel(()=>{throw Error('Incomplete state reached model');});
    const fallback=new ScriptedModel(()=>{throw Error('Incomplete state reached fallback');});
    let effects=0,classified=0;
    const harness=new SupportHarness({store,model,fallback,timeoutMs:1000,provider:{async refund(){effects++;throw Error('Unexpected financial effect');}},classifier:{provider:'synthetic',model:'synthetic',async classify(){classified++;throw Error('Unexpected classifier');}}});
    const supportCase=await harness.openCase(customer.sessionToken);
    const lease=await store.acquireTurn(supportCase.id,randomUUID());assert.ok(lease);
    for(let batch=0;batch<5;batch++){
      const source=await store.addMessage(supportCase.id,'customer','Preserve each existing request.');
      const catalog=await store.requestCatalog(supportCase.id);
      await store.requestCheckpoint(lease,source.id,{version:catalog.version,syncState:'needs_review',changes:Array.from({length:20},(_,index)=>({
        localKey:'goal_'+batch+'_'+index,title:'Goal '+(batch*20+index)+' '+ 't'.repeat(150),goal:'g'.repeat(1200),waitingOn:null,nextStep:null,sourceMessageIds:[source.id],dependencyIds:[],dependencyKeys:[],
      }))});
    }
    const old=await store.requestCatalog(supportCase.id);
    const last=old.requests.at(-1)!;
    const unknown=await store.createProposal({caseId:supportCase.id,tool:'external_action',args:{},argsHash:'a'.repeat(64),risk:'high',status:'unknown',policy:{allowed:true,requiresApproval:true,checks:[]}},lease,[{id:last.id,revision:last.revision}]);
    const source=await store.addMessage(supportCase.id,'customer','Please investigate another question.');
    if(accepted)await store.requestCheckpoint(lease,source.id,{version:(await store.requestCatalog(supportCase.id)).version,syncState:'needs_review',changes:[]});
    const before=await store.requestCatalog(supportCase.id);
    // Exercise the same accepted-message path used by queued workers, while retaining
    // a real leased store rather than overwriting its request-catalog implementation.
    const result=await harness.runTurn(customer.sessionToken,supportCase.id,source.body,lease,source.id);
    assert.equal(result.case.ownership,'staff');assert.equal(result.case.status,'escalated');
    assert.equal(model.calls,0);assert.equal(fallback.calls,0);assert.equal(effects,0);assert.equal(classified,0);
    const after=await store.requestCatalog(supportCase.id);
    assert.equal(after.requests.length,100);assert.equal(after.syncState,'needs_review');
    assert.deepEqual(after.requests.map(({id,goal,revision,lifecycle})=>({id,goal,revision,lifecycle})),before.requests.map(({id,goal,revision,lifecycle})=>({id,goal,revision,lifecycle})));
    assert.equal(after.lastSourceMessageId,source.id);
    assert.equal(after.version,before.version+(accepted?0:1)+1,'only the missing checkpoint and the handoff action link advance the catalog');
    assert.equal((await store.proposal(unknown.id))!.status,'unknown');
    const detail=await harness.detail(supportCase.id);
    assert.equal(detail.runs[0]!.error,'agent_context_unavailable');assert.equal(detail.runs[0]!.steps,0);
    assert.ok(detail.agentActivity.events.some(event=>event.type==='fallback'&&event.reason?.includes('no model was called')));
    assert.deepEqual((await store.proposals(supportCase.id)).map(proposal=>proposal.tool).sort(),['escalate_to_human','external_action']);
  });
});
