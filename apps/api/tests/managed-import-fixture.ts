import {readFile} from 'node:fs/promises';
import {fingerprint} from '../src/integrations/permissions.js';
import type {Manifest} from '../src/integrations/manifest.js';
import {ManagedGatewayClient} from '../src/integrations/managed-client.js';
import {MemorySupportStore} from '../src/modules/support/store.js';
import {seedData} from '../src/modules/support/seed.js';
import {IntegrationImportsService} from '../src/integrations/imports-service.js';
import type {ImportConfirmation,ImportDraft} from '../src/integrations/imports-contracts.js';
export async function managedFixture(){
 const store=new MemorySupportStore(seedData()),businessId=seedData().businesses[0]!.id,foreignBusinessId=seedData().businesses[1]!.id;
 const manifest=JSON.parse(await readFile(new URL('../../../examples/orders/manifest.json',import.meta.url),'utf8')) as Manifest;
 const spec=JSON.parse(await readFile(new URL('../../../examples/orders/normalized.openapi.json',import.meta.url),'utf8')) as Record<string,unknown>;
 const target=fingerprint({baseUrl:'https://upstream.example.invalid',principalId:'fixture'});
 const calls:{path:string;body:unknown;authorization:string|null}[]=[];let ready=true,installed=false,installCount=0;
 const fetcher:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,body,authorization:new Headers(init?.headers).get('authorization')});
  const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  if(path==='/control/capabilities')return json({credentialProfiles:[{id:'none',name:'Anonymous HTTPS',configured:true,upstreamBaseUrl:null},{id:'missing',name:'Missing profile',configured:false,upstreamBaseUrl:null}],guardDefinitions:[],privateToken:'must-not-return'});
  if(path==='/control/prepare')return json({spec,specHash:fingerprint(spec),upstreamBaseUrl:'https://upstream.example.invalid',upstreamTargetFingerprint:target,credentialProfileId:'none',principalId:'fixture',operations:manifest.operations.map(op=>({...op,supported:op.effect!=='unknown',reasonCode:op.effect==='unknown'?'unsupported':null,proposedEffect:'unknown',outputCandidates:op.outputFields}))});
  if(path==='/control/compile'){
   const reviewed=structuredClone(manifest);reviewed.integrationId=body.integrationId;reviewed.operations=reviewed.operations.filter(op=>Object.hasOwn(body.review.operations,op.operationKey)).map(op=>({...op,...body.review.operations[op.operationKey]}));
   for(const op of reviewed.operations)op.operationHash=fingerprint(op,'operationHash');reviewed.manifestHash=fingerprint(reviewed,'manifestHash');return json({manifest:reviewed,report:{},upstreamTargetFingerprint:target,principalId:'fixture'});
  }
  if(path==='/control/status'&&!installed)return json({},404);
  if(path==='/control/install'||path==='/control/status'){if(!ready)return json({},503);if(path==='/control/install'){installCount++;installed=true;}const hash=body.manifestHash??body.manifest.manifestHash;return json({ready:true,manifestHash:hash,connectionRevision:body.connectionRevision,upstreamTargetFingerprint:target,mcpPath:`/managed/${body.businessId}/${body.integrationId}/${body.connectionRevision}/${hash}/mcp`});}
  return json({},404);
 };
 const client=new ManagedGatewayClient({url:'https://manager.example.invalid',token:'synthetic-service-token-32-characters',allowInsecureHttp:false},fetcher);
 let verifies=0;const runtime={forContext:()=>({tools:[],callTool:async()=>undefined}),verifyCatalog:async()=>{verifies++;if(!ready)throw Error('private-provider-error');}};
 const service=new IntegrationImportsService(store.integrationStore,client,runtime);
 const prepare={integrationId:'orders',specUrl:'https://upstream.example.invalid/openapi.json',credentialProfileId:'none'};
 const confirmation=(draft:{version:number;specHash:string}):ImportConfirmation=>({version:draft.version,specHash:draft.specHash,operations:manifest.operations.filter(op=>op.effect!=='unknown').map((op,index)=>({operationKey:op.operationKey,mode:index===0?'auto':'ask',review:{effect:op.effect as 'read'|'write',scope:op.scope,outputFields:op.outputFields,guard:op.guard,idempotency:op.idempotency,reconciliation:op.reconciliation}}))});
 const draft=async()=>{const publicValue=await service.prepare(businessId,prepare);return {publicValue,stored:(await store.integrationStore.importDraft(businessId,publicValue.id)) as ImportDraft};};
 return {store,businessId,foreignBusinessId,manifest,client,fetcher,service,runtime,calls,prepare,confirmation,draft,setReady:(value:boolean)=>{ready=value;},loseRuntime:()=>{installed=false;},installCount:()=>installCount,verifies:()=>verifies};
}
