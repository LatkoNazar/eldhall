import {managedFixture} from './managed-import-fixture.js';
import {IntegrationImportsService} from '../src/integrations/imports-service.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { fingerprint } from '../src/integrations/permissions.js';
import { argsHash } from '../src/modules/agent/harness.js';
import { migrateSupport } from '../src/modules/support/migrations.js';
import { PostgresSupportStore } from '../src/modules/support/postgres-store.js';
import { seedData } from '../src/modules/support/seed.js';
import type { Manifest } from '../src/integrations/manifest.js';
import type { IntegrationPolicy } from '../src/integrations/permissions.js';

test('PostgreSQL integration state, admission, takeover, completion, expiry and recovery serialize across processes',{timeout:120000},async t=>{
  const base=process.env.TEST_DATABASE_URL?{connectionString:process.env.TEST_DATABASE_URL}:{host:process.env.TEST_POSTGRES_HOST??process.env.POSTGRES_HOST??'127.0.0.1',port:Number(process.env.TEST_POSTGRES_PORT??process.env.POSTGRES_PORT??5432),database:process.env.TEST_POSTGRES_DB??process.env.POSTGRES_DB??'app',user:process.env.TEST_POSTGRES_USER??process.env.POSTGRES_USER??'app',password:process.env.TEST_POSTGRES_PASSWORD??process.env.POSTGRES_PASSWORD??'development-only'};
  const schema='integration_test_'+randomUUID().replaceAll('-','');const admin=new pg.Pool({...base,connectionTimeoutMillis:3000});let pool:pg.Pool|undefined;
  try {
    await admin.query('CREATE SCHEMA '+schema);pool=new pg.Pool({...base,options:'-c search_path='+schema,max:10,connectionTimeoutMillis:3000});
    await migrateSupport(pool);await migrateSupport(pool);
    const store=new PostgresSupportStore(pool);await store.seedIfEmpty(seedData());
    const customer=(await store.customerBySession('demo-olena'))!;const businessId=customer.businessId;
    const manifest=JSON.parse(await readFile(new URL('../../../examples/orders/manifest.json',import.meta.url),'utf8')) as Manifest;
    const policy={...JSON.parse(await readFile(new URL('../../../examples/orders/policy.json',import.meta.url),'utf8')),businessId} as IntegrationPolicy;
    const seed={businessId,manifest,policy,connectionRevision:'1',connectionHash:'a'.repeat(64)};
    const registry=store.integrationStore;await registry.bootstrap(seed);
    const active=async()=>{const state=(await registry.get(businessId,'orders'))!;return registry.change(businessId,'orders',state.version,'test:reviewer','integration.activated',row=>({...row,enabled:true,draining:false,activeManifestHash:manifest.manifestHash,policy:{...policy,enabled:true,policyRevision:row.policy.policyRevision+1}}));};
    const proposal=async(options:{caseId?:string;expired?:boolean;auto?:boolean}={})=>{
      const supportCase=options.caseId?(await store.getCase(options.caseId))!:await store.createCase(businessId,customer.id);const state=(await registry.get(businessId,'orders'))!;const op=manifest.operations.find(row=>row.effect==='write')!;
      const args={businessId,customerId:customer.id,caseId:supportCase.id,ownershipVersion:supportCase.ownershipVersion,integrationId:'orders',operationKey:op.operationKey,operationHash:op.operationHash,manifestHash:manifest.manifestHash,connectionRevision:'1',policyRevision:state.policy.policyRevision,effect:'write',title:op.title,toolName:op.toolName,tags:op.tags,guard:{id:op.guard,status:'pending'},policySource:'group',matchedRuleIds:['orders'],managed:true,input:{order_id:'ORD-1001'},expiresAt:new Date(Date.now()+(options.expired?-1000:900000)).toISOString()};
      return store.createProposal({caseId:supportCase.id,tool:'external_action',args,argsHash:argsHash(supportCase.id,'external_action',args),risk:'high',status:'pending',policy:{allowed:true,requiresApproval:!options.auto,checks:[]}});
    };
    const approved=async()=>{const row=await proposal();assert.ok(await store.decideProposal(row.id,row.argsHash,'approved','operator:test'));return row;};
    await t.test('immutable bootstrap does not reactivate or overwrite operator policy; new store observes current state',async()=>{
      let state=(await registry.get(businessId,'orders'))!;assert.equal(state.enabled,false);assert.ok(state.policy.operations.every(row=>!row.enabled&&!row.reviewedOperationHash));
      state=await active();const persisted=await new PostgresSupportStore(pool!).integrationStore.get(businessId,'orders');assert.equal(persisted!.version,state.version);
      const results=await Promise.allSettled([registry.change(businessId,'orders',state.version,'test:a','integration.policy_updated',row=>({...row,policy:{...row.policy,defaultMode:'ask',policyRevision:row.policy.policyRevision+1}})),registry.change(businessId,'orders',state.version,'test:b','integration.policy_updated',row=>({...row,policy:{...row.policy,defaultMode:'auto',policyRevision:row.policy.policyRevision+1}}))]);
      assert.equal(results.filter(row=>row.status==='fulfilled').length,1);const edited=(await registry.get(businessId,'orders'))!;await registry.bootstrap(seed);assert.deepEqual(await registry.get(businessId,'orders'),edited);
    });
    await t.test('two claims create exactly one durable execution; completion and final reply are idempotent',async()=>{
      await active();const row=await approved();const claims=await Promise.all([store.claimExecution(row.id,row.argsHash,'operator:a'),new PostgresSupportStore(pool!).claimExecution(row.id,row.argsHash,'operator:b')]);assert.equal(claims.filter(Boolean).length,1);
      assert.equal(await store.markExternalDispatched(row.id),true);assert.equal(await store.markExternalDispatched(row.id),false);
      await Promise.all([store.finishExternalAction(row.id,'executed',{data:{status:'cancelled'}},null,'Confirmed cancellation','operator:a'),store.finishExternalAction(row.id,'unknown',null,'late_error','Must not be inserted','operator:b')]);
      const done=(await store.proposal(row.id))!;assert.ok(['executed','unknown'].includes(done.status));assert.equal((await store.messages(row.caseId)).length,1);assert.equal((await pool!.query('SELECT count(*)::int AS n FROM support_external_executions WHERE action_id=$1',[row.id])).rows[0].n,1);
      if(done.status==='unknown') await store.finishExternalAction(row.id,'executed',{data:{status:'cancelled'}},null,'Verified','operator:reconcile',true);
      const audit=await store.auditEvents(row.caseId);assert.equal(audit.filter(event=>event.type==='action.claimed').length,1);assert.equal(audit.filter(event=>event.type==='action.dispatched').length,1);
      await store.setOwnership(row.caseId,'bot','operator:resume');const lease=(await store.acquireTurn(row.caseId,randomUUID()))!;const before=(await store.messages(row.caseId)).length;
      assert.ok(await store.completeTurn(lease,{},'Must reuse recorded completion',[],{policy:(await store.business(businessId))!.policy,skills:[],completionActionId:row.id}));assert.equal((await store.messages(row.caseId)).length,before);await store.releaseTurn(lease);
    });
    await t.test('disable and admission share a serialization point and a restart cannot restore access',async()=>{
      await active();const row=await approved();const state=(await registry.get(businessId,'orders'))!;
      const [claim]=await Promise.all([store.claimExecution(row.id,row.argsHash,'operator:a'),registry.change(businessId,'orders',state.version,'operator:b','integration.disabled',current=>({...current,enabled:false,draining:true,policy:{...current.policy,enabled:false,policyRevision:current.policy.policyRevision+1}}))]);
      assert.equal((await registry.get(businessId,'orders'))!.enabled,false);
      if(claim) await store.finishExternalAction(row.id,'failed',null,'not_dispatched','Not dispatched','operator:a');else assert.equal((await store.proposal(row.id))!.status,'invalidated');
      await registry.bootstrap(seed);assert.equal((await new PostgresSupportStore(pool!).integrationStore.get(businessId,'orders'))!.enabled,false);
    });
    await t.test('takeover concurrent with confirmed completion has no lock inversion or lost outcome',async()=>{
      await active();const row=await approved();assert.ok(await store.claimExecution(row.id,row.argsHash,'operator:a'));assert.equal(await store.markExternalDispatched(row.id),true);
      const results=await Promise.allSettled([store.setOwnership(row.caseId,'staff','operator:takeover'),store.finishExternalAction(row.id,'executed',{data:{status:'cancelled'}},null,'Confirmed after takeover','operator:a')]);assert.ok(results.every(row=>row.status==='fulfilled'));
      assert.equal((await store.proposal(row.id))!.status,'executed');assert.equal((await store.getCase(row.caseId))!.ownership,'staff');assert.equal((await store.messages(row.caseId)).length,1);
    });
    await t.test('expiry is durable, audited, terminal and clears the waiting conversation exactly once',async()=>{
      const row=await proposal({expired:true});await Promise.all([store.expireExternalActions(),new PostgresSupportStore(pool!).expireExternalActions()]);assert.equal((await store.proposal(row.id))!.status,'expired');assert.equal((await store.getCase(row.caseId))!.status,'escalated');assert.equal((await store.getCase(row.caseId))!.ownership,'staff');assert.equal((await store.messages(row.caseId)).length,1);assert.equal((await store.auditEvents(row.caseId)).filter(event=>event.type==='action.expired').length,1);
    });
    await t.test('recovery and dispatch race never classify a dispatched write as clean failure; unknown blocks new actions after resume',async()=>{
      await active();const row=await approved();assert.ok(await store.claimExecution(row.id,row.argsHash,'operator:a'));await pool!.query("UPDATE support_proposals SET decided_at=now()-interval '181 seconds' WHERE id=$1",[row.id]);
      const [sent]=await Promise.all([store.markExternalDispatched(row.id),new PostgresSupportStore(pool!).recoverInterruptedExecutions()]);const recovered=(await store.proposal(row.id))!;assert.equal(recovered.status,sent?'unknown':'failed');assert.equal((await store.messages(row.caseId)).length,1);assert.equal(await store.markExternalDispatched(row.id),false);
      if(sent) {
        await store.setOwnership(row.caseId,'bot','operator:resume');const another=await proposal({caseId:row.caseId});await store.decideProposal(another.id,another.argsHash,'approved','operator:a');assert.equal((await store.proposal(another.id))!.status,'invalidated');assert.equal((await store.proposal(another.id))!.error,'unknown_execution_pending');
        const reconciled=await Promise.allSettled([store.finishExternalAction(row.id,'executed',{data:{status:'cancelled'}},null,'Verified success','operator:a',true),store.finishExternalAction(row.id,'failed',null,'verified_no_effect','Verified failure','operator:b',true)]);assert.equal(reconciled.filter(row=>row.status==='fulfilled').length,1);assert.equal((await store.auditEvents(row.caseId)).filter(event=>event.type==='action.reconciled').length,1);
      }
    });
    await t.test('separate legitimate actions with identical inputs retain independent IDs; final delivery fences current policy atomically',async()=>{
      await active();const first=await approved();const second=await approved();assert.notEqual(first.id,second.id);assert.ok(await store.claimExecution(first.id,first.argsHash,'operator:a'));assert.ok(await store.claimExecution(second.id,second.argsHash,'operator:a'));await store.finishExternalAction(first.id,'failed',null,'test','No effect','operator:a');await store.finishExternalAction(second.id,'failed',null,'test','No effect','operator:a');
      const supportCase=await store.createCase(businessId,customer.id);const lease=(await store.acquireTurn(supportCase.id,randomUUID()))!;const state=(await registry.get(businessId,'orders'))!;
      await registry.change(businessId,'orders',state.version,'operator:a','integration.policy_updated',current=>({...current,policy:{...current.policy,policyRevision:current.policy.policyRevision+1}}));
      assert.equal(await store.completeTurn(lease,{},'Stale private result',[],{policy:(await store.business(businessId))!.policy,skills:[],integrationRefs:[{integrationId:'orders',manifestHash:manifest.manifestHash,connectionRevision:'1',policyRevision:state.policy.policyRevision}]}),null);assert.equal((await store.messages(supportCase.id)).length,0);
    });
    await t.test('deterministic unknown holds admission after resume and opposite reconciliation races have one winner',async()=>{
      await active();const row=await approved();assert.ok(await store.claimExecution(row.id,row.argsHash,'operator:a'));assert.ok(await store.markExternalDispatched(row.id));await store.finishExternalAction(row.id,'unknown',null,'outcome_unknown','Needs verification','operator:a');
      await store.setOwnership(row.caseId,'bot','operator:resume');const next=await proposal({caseId:row.caseId});assert.equal(await store.decideProposal(next.id,next.argsHash,'approved','operator:a'),null);assert.equal((await store.proposal(next.id))!.error,'unknown_execution_pending');assert.equal((await store.getCase(row.caseId))!.ownership,'staff');
      const outcomes=await Promise.allSettled([store.finishExternalAction(row.id,'executed',{data:{status:'cancelled'}},null,'Verified success','operator:a',true),store.finishExternalAction(row.id,'failed',null,'no_effect','Verified failure','operator:b',true)]);assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);assert.equal((await store.auditEvents(row.caseId)).filter(event=>event.type==='action.reconciled').length,1);
    });
    await t.test('managed import registration is atomic, scoped and replayable across PostgreSQL store restarts',async()=>{
      const fixture=await managedFixture();fixture.prepare.integrationId='managed-pg';
      const imports=new IntegrationImportsService(store.integrationStore,fixture.client,fixture.runtime);
      const draft=await imports.prepare(businessId,fixture.prepare),body=fixture.confirmation(draft);
      assert.equal(await store.integrationStore.importDraft(fixture.foreignBusinessId,draft.id),null);
      fixture.setReady(false);const persisted=await imports.confirm(businessId,draft.id,body);assert.equal(persisted.activation,'disabled');
      assert.equal((await pool!.query('SELECT count(*)::int n FROM support_integrations WHERE business_id=$1 AND integration_id=$2',[businessId,'managed-pg'])).rows[0].n,1);
      const restarted=new PostgresSupportStore(pool!);fixture.setReady(true);
      const resumed=new IntegrationImportsService(restarted.integrationStore,fixture.client,fixture.runtime);
      const completed=await Promise.all([resumed.confirm(businessId,draft.id,body),imports.confirm(businessId,draft.id,body)]);assert.ok(completed.every(row=>row.activation==='active'));
      assert.equal((await restarted.integrationStore.events(businessId,'managed-pg')).filter(row=>row.type==='integration.imported').length,1);
      const state=(await restarted.integrationStore.get(businessId,'managed-pg'))!;assert.equal(state.managedConnection!.inventory.length,3);assert.ok(await restarted.integrationStore.manifest(businessId,'managed-pg',state.loadedManifestHash));
      await migrateSupport(pool!);assert.deepEqual(await new PostgresSupportStore(pool!).integrationStore.get(businessId,'managed-pg'),state);
      await assert.rejects(resumed.confirm(businessId,draft.id,{...body,operations:[]}));
      const disabled=await restarted.integrationStore.change(businessId,'managed-pg',state.version,'operator:test','integration.disabled',row=>({...row,enabled:false,draining:true}));
      assert.equal((await resumed.confirm(businessId,draft.id,body)).activation,'disabled');assert.equal((await restarted.integrationStore.get(businessId,'managed-pg'))!.version,disabled.version);
      const competing=await imports.prepare(businessId,{...fixture.prepare,integrationId:'managed-conflict'});
      const stored=(await store.integrationStore.importDraft(businessId,competing.id))!;
      const clone={...structuredClone(stored),id:randomUUID()};await store.integrationStore.createImport(clone);
      const outcomes=await Promise.allSettled([imports.confirm(businessId,competing.id,fixture.confirmation(competing)),imports.confirm(businessId,clone.id,fixture.confirmation({version:clone.version,specHash:clone.prepared.specHash}))]);
      assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
      const loser=outcomes[0]!.status==='rejected'?competing.id:clone.id;assert.equal((await store.integrationStore.importDraft(businessId,loser))!.status,'prepared');
      assert.equal((await pool!.query('SELECT count(*)::int n FROM support_integration_manifests WHERE business_id=$1 AND integration_id=$2',[businessId,'managed-conflict'])).rows[0].n,1);
      for(let count=(await store.integrationStore.list(businessId)).length;count<19;count++){const copy=structuredClone(fixture.manifest);copy.integrationId='quota-'+count;copy.manifestHash=fingerprint(copy,'manifestHash');await store.integrationStore.bootstrap({businessId,manifest:copy,connectionRevision:'1',connectionHash:'0'.repeat(64),policy:{businessId,integrationId:copy.integrationId,enabled:false,manifestHash:copy.manifestHash,policyRevision:1,defaultMode:'deny',groups:[],operations:[]}});}
      const a=await imports.prepare(businessId,{...fixture.prepare,integrationId:'quota-a'}),b=await imports.prepare(businessId,{...fixture.prepare,integrationId:'quota-b'});fixture.setReady(false);
      const quota=await Promise.allSettled([imports.confirm(businessId,a.id,fixture.confirmation(a)),imports.confirm(businessId,b.id,fixture.confirmation(b))]);assert.equal(quota.filter(row=>row.status==='fulfilled').length,1);assert.equal((await store.integrationStore.list(businessId)).length,20);

    });
  } finally {await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();}
});
