import {fingerprint} from '../src/integrations/permissions.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import Fastify from 'fastify';
import {managedFixture} from './managed-import-fixture.js';
import {getManagedSupportOptions,ManagedGatewayClient} from '../src/integrations/managed-client.js';
import {IntegrationImportsService} from '../src/integrations/imports-service.js';
import {withManagedIntegrations} from '../src/integrations/managed-runtime.js';
import {integrationRoutes} from '../src/integrations/routes.js';
import {SupportHarness} from '../src/modules/agent/harness.js';
import {RulesModel} from '../src/modules/agent/model.js';
import {SimulatedPaymentProvider} from '../src/modules/support/payment-provider.js';
import {prepareImportSchema} from '../src/integrations/imports-contracts.js';

test('managed settings are explicit; credential URLs and reserved route identifiers fail before I/O',()=>{
 assert.equal(getManagedSupportOptions({}),undefined);
 for(const value of [{MANAGED_MCP_URL:'https://manager.invalid'},{MANAGED_MCP_URL:'https://user:secret@manager.invalid',MANAGED_MCP_TOKEN:'x'.repeat(32)},{MANAGED_MCP_URL:'https://manager.invalid/#secret',MANAGED_MCP_TOKEN:'x'.repeat(32)}])assert.throws(()=>getManagedSupportOptions(value));
 for(const integrationId of ['.','..','__proto__','constructor','prototype','eldhall'])assert.equal(prepareImportSchema.safeParse({integrationId,specUrl:'https://source.invalid/openapi.json'}).success,false);
 assert.equal(getManagedSupportOptions({MANAGED_MCP_URL:'http://127.0.0.1:8103',MANAGED_MCP_TOKEN:'x'.repeat(32)})!.url,'http://127.0.0.1:8103');
});

test('prepare is scoped, unreviewed and omits raw specs and private capability fields',async()=>{
 const f=await managedFixture(),draft=await f.service.prepare(f.businessId,f.prepare);
 assert.equal(draft.operations.every(row=>row.mode==='deny'),true);assert.equal('spec' in draft,false);assert.equal((await f.store.integrationStore.list(f.businessId)).length,0);
 assert.equal((await f.service.capabilities()).credentialProfiles[0]!.id,'none');assert.equal('privateToken' in await f.service.capabilities(),false);
 await assert.rejects(f.service.draft(f.foreignBusinessId,draft.id));
 const count=f.calls.filter(call=>call.path==='/control/prepare').length;
 await assert.rejects(f.service.prepare(f.businessId,{...f.prepare,credentialProfileId:'missing'}));assert.equal(f.calls.filter(call=>call.path==='/control/prepare').length,count);
 assert.ok(f.calls.every(call=>call.authorization==='Bearer synthetic-service-token-32-characters'));
});

test('confirmation requires exact snapshot and explicit supported review before registration',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft(),body=f.confirmation(draft);
 for(const invalid of [{...body,version:99},{...body,specHash:'0'.repeat(64)},{...body,operations:[{operationKey:body.operations[0]!.operationKey,mode:'auto'}]},{...body,operations:[{...body.operations[0]!,operationKey:'DELETE /unprepared'}]},{...body,operations:[{...body.operations[0]!,operationKey:f.manifest.operations[2]!.operationKey}]}])await assert.rejects(f.service.confirm(f.businessId,draft.id,invalid));
 assert.deepEqual(await f.store.integrationStore.list(f.businessId),[]);
 const {stored}=await f.draft();stored.id=randomUUID();stored.expiresAt=new Date(0).toISOString();await f.store.integrationStore.createImport(stored);await assert.rejects(f.service.confirm(f.businessId,stored.id,f.confirmation({version:stored.version,specHash:stored.prepared.specHash})));
});

test('failed runtime stays disabled, concurrent retry is idempotent and old confirmation cannot undo manual disable',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft(),body=f.confirmation(draft);f.setReady(false);
 const first=await f.service.confirm(f.businessId,draft.id,body);assert.equal(first.activation,'disabled');assert.equal(first.runtime,'unavailable');assert.equal(first.state.managedConnection!.inventory.length,3);
 const restarted=new IntegrationImportsService(f.store.integrationStore,f.client,f.runtime);f.setReady(true);
 const results=await Promise.all([restarted.confirm(f.businessId,draft.id,body),restarted.confirm(f.businessId,draft.id,body)]);assert.ok(results.every(row=>row.activation==='active'));
 assert.equal((await f.store.integrationStore.events(f.businessId,'orders')).filter(row=>row.type==='integration.imported').length,1);assert.equal((await f.store.integrationStore.events(f.businessId,'orders')).filter(row=>row.type==='integration.activated').length,1);
 const state=results[0]!.state;const disabled=await f.store.integrationStore.change(f.businessId,'orders',state.version,'operator:staff','integration.disabled',current=>({...current,enabled:false,draining:true}));
 assert.equal((await restarted.confirm(f.businessId,draft.id,body)).activation,'disabled');assert.equal((await f.store.integrationStore.get(f.businessId,'orders'))!.version,disabled.version);
 await assert.rejects(restarted.confirm(f.businessId,draft.id,{...body,operations:[]}));
});

test('reviewed Deny revokes operation authority; unsupported inventory stays separate',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft(),body=f.confirmation(draft);body.operations[0]!.mode='deny';const result=await f.service.confirm(f.businessId,draft.id,body);
 const first=result.state.policy.operations[0]!;assert.equal(first.enabled,false);assert.equal(first.mode,'deny');assert.equal(first.reviewedOperationHash,null);assert.equal(result.state.policy.operations.some(row=>row.operationKey===f.manifest.operations[2]!.operationKey),false);
});

test('fresh DB resolver rehydrates lost gateway cache without static catalogs or upstream secrets',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft();await f.service.confirm(f.businessId,draft.id,f.confirmation(draft));
 const original={forContext:()=>({tools:[],callTool:async()=>undefined})};const runtime=withManagedIntegrations(original,f.store.integrationStore,f.client);
 const context={businessId:f.businessId,customerId:randomUUID(),assertActive:async()=>undefined};
 assert.deepEqual((await runtime.forContext(context).listTools!()).map(row=>row.name),['get_order_status','cancel_order']);assert.equal(f.installCount(),1);
 f.loseRuntime();const freshClient=new ManagedGatewayClient(f.client.options,f.fetcher);
 const restarted=withManagedIntegrations(original,f.store.integrationStore,freshClient);assert.equal((await restarted.forContext(context).listTools!()).length,2);assert.equal(f.installCount(),2);
 const count=f.calls.length;assert.deepEqual(await runtime.forContext({...context,businessId:f.foreignBusinessId}).listTools!(),[]);assert.equal(f.calls.length,count);
 assert.doesNotMatch(JSON.stringify(f.calls.map(call=>call.body)),/BANK_LAB_UPSTREAM_TOKEN|upstream-secret/);
});

test('import HTTP routes preserve staff auth and workspace scope; runtime failures are honestly disabled',async()=>{
 const f=await managedFixture(),rules=new RulesModel(),harness=new SupportHarness({store:f.store,model:rules,fallback:rules,provider:new SimulatedPaymentProvider(),timeoutMs:1000});
 const app=Fastify();await app.register(integrationRoutes,{support:{store:f.store,harness,workspaceBusinessId:f.businessId,integrationImports:f.service},operatorToken:'operator-test-token'});const auth={authorization:'Bearer operator-test-token'};
 try{
  assert.equal((await app.inject({url:'/api/v1/integration-imports/capabilities?businessId='+f.businessId})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/integration-imports/prepare?businessId='+f.foreignBusinessId,headers:auth,payload:f.prepare})).statusCode,404);assert.equal(f.calls.length,0);
  const preview=await app.inject({method:'POST',url:'/api/v1/integration-imports/prepare?businessId='+f.businessId,headers:auth,payload:f.prepare});assert.equal(preview.statusCode,200);f.setReady(false);
  const draft=preview.json();const confirm=await app.inject({method:'POST',url:'/api/v1/integration-imports/'+draft.id+'/confirm?businessId='+f.businessId,headers:auth,payload:f.confirmation(draft)});assert.equal(confirm.statusCode,200);assert.equal(confirm.json().activation,'disabled');assert.equal(confirm.json().runtime,'unavailable');
 }finally{await app.close();}
});


test('control failures expose only stable actionable codes, never upstream error text or credentials',async()=>{
 for(const [code,status] of [['openapi_json_required',422],['address_blocked',403],['compiler_busy',503],['profile_target_mismatch',422],['response_too_large',413],['encoded_response_refused',422],['egress_busy',503],['spec_unavailable',502],['invalid_url',422],['upstream_unavailable',502],['untrusted-private-error',422]] as const){
  const client=new ManagedGatewayClient({url:'https://manager.example.invalid',token:'synthetic-service-token-32-characters',allowInsecureHttp:false},async()=>new Response(JSON.stringify({code,detail:'private-provider-token-value',url:'https://private.invalid'}),{status:422}));
  await assert.rejects(client.capabilities(),error=>{assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/private-provider-token-value|private.invalid/);assert.equal((error as {status?:number}).status,status);assert.equal((error as {code?:string}).code,code==='untrusted-private-error'?'managed_request_refused':code);return true;});
 }
});


test('managed cache installation rejects namespace, target and revision confusion before returning a runtime URL',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft(),confirmed=await f.service.confirm(f.businessId,draft.id,f.confirmation(draft));
 const state=confirmed.state,manifest=(await f.store.integrationStore.manifest(f.businessId,state.integrationId,state.loadedManifestHash))!;
 for(const wrong of [{mcpPath:'/managed/foreign/mcp'},{upstreamTargetFingerprint:'0'.repeat(64)},{connectionRevision:'2'}]){
  const fake:typeof fetch=async()=>new Response(JSON.stringify({ready:true,manifestHash:state.loadedManifestHash,connectionRevision:state.connectionRevision,upstreamTargetFingerprint:state.managedConnection!.upstreamTargetFingerprint,mcpPath:`/managed/${state.businessId}/${state.integrationId}/${state.connectionRevision}/${state.loadedManifestHash}/mcp`,...wrong}));
  const client=new ManagedGatewayClient(f.client.options,fake);await assert.rejects(client.ensure(state,manifest));
 }
});


test('a rehashed compiler response still cannot widen explicitly reviewed output fields',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft();
 const fetcher:typeof fetch=async(input,init)=>{const response=await f.fetcher(input,init);if(new URL(String(input)).pathname!=='/control/compile')return response;const body=await response.json();const operation=body.manifest.operations[0];operation.outputFields.push('private_extra');operation.operationHash=fingerprint(operation,'operationHash');body.manifest.manifestHash=fingerprint(body.manifest,'manifestHash');return new Response(JSON.stringify(body));};
 const service=new IntegrationImportsService(f.store.integrationStore,new ManagedGatewayClient(f.client.options,fetcher),f.runtime);
 await assert.rejects(service.confirm(f.businessId,draft.id,f.confirmation(draft)),/explicit operator review/);assert.deepEqual(await f.store.integrationStore.list(f.businessId),[]);
});

test('concurrent confirmations at nineteen catalogs admit only one twentieth catalog',async()=>{
 const f=await managedFixture();
 for(let index=0;index<19;index++){const manifest=structuredClone(f.manifest);manifest.integrationId='quota-'+index;manifest.manifestHash=fingerprint(manifest,'manifestHash');await f.store.integrationStore.bootstrap({businessId:f.businessId,manifest,connectionRevision:'1',connectionHash:'0'.repeat(64),policy:{businessId:f.businessId,integrationId:manifest.integrationId,enabled:false,manifestHash:manifest.manifestHash,policyRevision:1,defaultMode:'deny',groups:[],operations:[]}});}
 const a=await f.service.prepare(f.businessId,{...f.prepare,integrationId:'quota-a'}),b=await f.service.prepare(f.businessId,{...f.prepare,integrationId:'quota-b'});f.setReady(false);
 const results=await Promise.allSettled([f.service.confirm(f.businessId,a.id,f.confirmation(a)),f.service.confirm(f.businessId,b.id,f.confirmation(b))]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal((await f.store.integrationStore.list(f.businessId)).length,20);
});


test('revoked context and disabled managed connections are refused before gateway installation',async()=>{
 const f=await managedFixture(),{publicValue:draft}=await f.draft(),confirmed=await f.service.confirm(f.businessId,draft.id,f.confirmation(draft));
 const runtime=withManagedIntegrations({forContext:()=>({tools:[],callTool:async()=>undefined})},f.store.integrationStore,f.client);
 const count=f.calls.length;await assert.rejects(runtime.forContext({businessId:f.businessId,customerId:randomUUID(),assertActive:async()=>{throw Error('revoked');}}).listTools!(),/revoked/);assert.equal(f.calls.length,count);
 await f.store.integrationStore.change(f.businessId,'orders',confirmed.state.version,'operator:test','integration.disabled',current=>({...current,enabled:false}));
 await assert.rejects(runtime.forContext({businessId:f.businessId,customerId:randomUUID(),assertActive:async()=>undefined}).callTool('orders','get_order_status',{order_id:'ORD-1001'}),/disabled/);assert.equal(f.calls.length,count);
});
