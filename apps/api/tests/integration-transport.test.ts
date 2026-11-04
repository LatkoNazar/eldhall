import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createCatalogIntegration } from '../src/integrations/catalog.js';
import type { Manifest } from '../src/integrations/manifest.js';
import { IntegrationError, type ExternalActionRequest } from '../src/integrations/mcp.js';
import type { IntegrationPolicy } from '../src/integrations/permissions.js';
import { MemoryIntegrationStore } from '../src/integrations/state.js';

const manifest=JSON.parse(await readFile(new URL('../../../examples/orders/manifest.json',import.meta.url),'utf8')) as Manifest;
const policy=JSON.parse(await readFile(new URL('../../../examples/orders/policy.json',import.meta.url),'utf8')) as IntegrationPolicy;
const scope={type:'object',properties:{customerId:{type:'string',maxLength:200},businessId:{type:'string',maxLength:200},idempotencyKey:{type:'string',maxLength:200}},required:['customerId'],additionalProperties:false};
async function fakeMcp(run:(calls:Record<string,unknown>[])=>Promise<void>,onOperation:()=>Promise<void>=async()=>undefined,drift=false) {
  const original=globalThis.fetch;const calls:Record<string,unknown>[]=[];
  globalThis.fetch=async(input,init)=>{
    const request=typeof init?.body==='string'?JSON.parse(init.body) as {id?:number;method:string;params?:Record<string,unknown>}:input instanceof Request?await input.json() as {id?:number;method:string;params?:Record<string,unknown>}:null;
    if(!request||request.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(request.method==='initialize') result={protocolVersion:request.params?.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'test-reviewed-sidecar',version:'1'}};
    else if(request.method==='tools/list') result={tools:manifest.operations.filter(op=>op.effect!=='unknown').map(op=>({name:op.toolName,description:op.description,annotations:{readOnlyHint:op.effect==='read'},inputSchema:{...op.inputSchema,properties:{...op.inputSchema.properties,eldhall:scope,...(drift?{injected:{type:'string'}}:{})},required:[...(op.inputSchema.required??[]),'eldhall']}}))};
    else if(request.method==='tools/call'&&request.params?.name==='get_connector_manifest') result={content:[],structuredContent:{manifestHash:manifest.manifestHash,adapterContractVersion:1,connectionRevision:'1',upstreamTargetFingerprint:'a'.repeat(64),tools:Object.fromEntries(manifest.operations.filter(op=>op.effect!=='unknown').map(op=>[op.toolName,op.operationHash]))}};
    else if(request.method==='tools/call') {calls.push(request.params!);await onOperation();result={content:[],structuredContent:{order_id:'ORD-1001',status:'cancelled',private_email:'hidden@example.test'}};}
    else result={};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{await run(calls);}finally{globalThis.fetch=original;}
}
const config={businessId:policy.businessId,url:'https://reviewed-sidecar.example/mcp',credential:'test-token',manifest,policy};

test('received write success survives takeover after dispatch while pre-dispatch ownership stays fenced',async()=>{
  let active=true;const requests:ExternalActionRequest[]=[];
  const tools=createCatalogIntegration(config).forContext({businessId:policy.businessId,customerId:'test-customer',assertActive:async()=>{if(!active) throw new Error('takeover');},propose:async request=>{requests.push(request);return{status:'awaiting_approval',proposalId:'p',summary:request.title};}});
  await tools.callTool('orders','cancel_order',{order_id:'ORD-1001'});
  await fakeMcp(async calls=>{const outcome=await tools.executeAction!(requests[0]!.args,'action-1');assert.equal(outcome.status,'executed');assert.deepEqual(outcome.guard,{id:'orders.cancel_before_shipment',status:'passed'});assert.equal(calls.length,1);},async()=>{active=false;});
  assert.equal((await tools.executeAction!(requests[0]!.args,'action-2')).status,'failed');
});

test('policy revocation during an auto read prevents data delivery, including a still-allowed new revision',async()=>{
  const registry=new MemoryIntegrationStore();await registry.bootstrap({businessId:policy.businessId,manifest,policy,connectionRevision:'1',connectionHash:'b'.repeat(64)});
  const initial=(await registry.get(policy.businessId,'orders'))!;await registry.change(policy.businessId,'orders',initial.version,'test','integration.activated',state=>({...state,enabled:true,activeManifestHash:manifest.manifestHash,policy:{...policy,enabled:true}}));
  const tools=createCatalogIntegration({...config,registry,upstreamTargetFingerprint:'a'.repeat(64)}).forContext({businessId:policy.businessId,customerId:'test-customer',assertActive:async()=>undefined});
  assert.equal((await tools.listTools!()).length,2);
  await fakeMcp(async calls=>{await assert.rejects(tools.callTool('orders','get_order_status',{order_id:'ORD-1001'}),(error:unknown)=>error instanceof IntegrationError&&error.code==='denied');assert.equal(calls.length,1);},async()=>{const state=(await registry.get(policy.businessId,'orders'))!;await registry.change(policy.businessId,'orders',state.version,'operator','integration.policy_updated',row=>({...row,policy:{...row.policy,policyRevision:row.policy.policyRevision+1}}));});
});

test('sidecar schema drift is denied before the business operation even when hashes are advertised correctly',async()=>{
  const tools=createCatalogIntegration(config).forContext({businessId:policy.businessId,customerId:'test-customer',assertActive:async()=>undefined});
  await fakeMcp(async calls=>{await assert.rejects(tools.callTool('orders','get_order_status',{order_id:'ORD-1001'}),(error:unknown)=>error instanceof IntegrationError&&error.code==='denied');assert.equal(calls.length,0);},async()=>undefined,true);
});

test('malformed DB-held policy never advertises or dispatches an operation',async()=>{
  const registry=new MemoryIntegrationStore();await registry.bootstrap({businessId:policy.businessId,manifest,policy,connectionRevision:'1',connectionHash:'b'.repeat(64)});
  const initial=(await registry.get(policy.businessId,'orders'))!;await registry.change(policy.businessId,'orders',initial.version,'test','integration.activated',state=>({...state,enabled:true,activeManifestHash:manifest.manifestHash,policy:{...policy,enabled:true}}));
  Reflect.set(registry.peek(policy.businessId,'orders')!.policy,'defaultMode','allowed');
  const tools=createCatalogIntegration({...config,registry,upstreamTargetFingerprint:'a'.repeat(64)}).forContext({businessId:policy.businessId,customerId:'test-customer',assertActive:async()=>undefined});
  assert.deepEqual(await tools.listTools!(),[]);
  await assert.rejects(tools.callTool('orders','get_order_status',{order_id:'ORD-1001'}),(error:unknown)=>error instanceof IntegrationError&&error.code==='denied'&&/policy_invalid/.test(error.message));
});
