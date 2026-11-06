import Fastify from 'fastify';
import {ManagedGatewayClient} from '../src/integrations/managed-client.js';
import {withManagedIntegrations} from '../src/integrations/managed-runtime.js';
import {IntegrationImportsService} from '../src/integrations/imports-service.js';
import {supportRoutes} from '../src/modules/support/routes.js';
// Real stack: mock Orders upstream (node) <- Python FastMCP sidecar (uv) <- TS catalog integration.
// Run: npm run test:mcp-openapi  (needs uv; apps/mcp-openapi dependencies resolve on first run).
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { createCatalogIntegration, createSupportIntegrations } from '../src/integrations/catalog.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import type { Manifest } from '../src/integrations/manifest.js';
import { IntegrationError, type ExternalActionRequest } from '../src/integrations/mcp.js';
import { fingerprint } from '../src/integrations/permissions.js';
import { MemoryIntegrationStore } from '../src/integrations/state.js';
import type { IntegrationPolicy } from '../src/integrations/permissions.js';
// @ts-expect-error plain .mjs fixture without type declarations
import { createOrdersApi } from '../../../examples/orders/mock-api.mjs';

const orders = new URL('../../../examples/orders/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', orders), 'utf8')) as Manifest;
const policy = JSON.parse(await readFile(new URL('policy.json', orders), 'utf8')) as { businessId: string; operations: { reviewedOperationHash: string | null }[] };
const serviceToken = 'local-sidecar-service-token';
// Seeded Eldhall customers (src/modules/support/seed.ts); the mock upstream owns orders under the same ids.
const OLENA = '00000000-0000-4000-8000-000000000101';
const TARAS = '00000000-0000-4000-8000-000000000102';
const NOVAPAY = '00000000-0000-4000-8000-000000000001';
const context = { businessId: policy.businessId, customerId: OLENA, assertActive: async () => undefined };
const code = (expected: IntegrationError['code'], message?: RegExp) => (error: unknown) => error instanceof IntegrationError && error.code === expected && (!message || message.test(error.message));

let upstream: Server;
let sidecar: ChildProcess;
let sidecarUrl = '';
let upstreamTargetFingerprint='';

const freePort = () => new Promise<number>(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });

before(async () => {
  upstream = createOrdersApi({ token: 'upstream-token', customers: { olena: OLENA, taras: TARAS } }) as Server;
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  upstreamTargetFingerprint=fingerprint({baseUrl:`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,principalId:'default'});
  sidecarUrl = `http://127.0.0.1:${port}/mcp`;
  sidecar = spawn('uv', ['run', '--quiet', '--project', fileURLToPath(new URL('../../mcp-openapi/', import.meta.url)), 'support-mcp-server'], {
    env: { ...process.env, MANIFEST_PATH: fileURLToPath(new URL('manifest.json', orders)), UPSTREAM_BASE_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, UPSTREAM_TOKEN: 'upstream-token', MCP_SERVICE_TOKEN: serviceToken, PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32', // own process group, so the whole tree can be stopped
  });
  for (let i = 0; i < 300; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false);
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('sidecar did not become healthy');
});

after(async () => {
  // `uv run` leaves the Python child alive if only the wrapper is killed.
  if (sidecar?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(sidecar.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-sidecar.pid, 'SIGTERM');
  }
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
});

const integration = (overrides: Partial<Parameters<typeof createCatalogIntegration>[0]> = {}) => createCatalogIntegration({
  businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, timeoutMs: 5000, manifest, policy, ...overrides,
}).forContext(context);

test('managed catalog refuses wrong upstream target or connection revision before any business operation',async()=>{
  for(const expected of [{upstreamTargetFingerprint:'b'.repeat(64),connectionRevision:'1'},{upstreamTargetFingerprint,connectionRevision:'2'}]) {
    const registry=new MemoryIntegrationStore();const reviewedPolicy=policy as IntegrationPolicy;
    await registry.bootstrap({businessId:policy.businessId,manifest,policy:reviewedPolicy,connectionRevision:expected.connectionRevision,connectionHash:'c'.repeat(64)});
    const initial=(await registry.get(policy.businessId,'orders'))!;await registry.change(policy.businessId,'orders',initial.version,'test','integration.activated',state=>({...state,enabled:true,activeManifestHash:manifest.manifestHash,policy:{...reviewedPolicy,enabled:true}}));
    const connector=createCatalogIntegration({businessId:policy.businessId,url:sidecarUrl,credential:serviceToken,allowInsecureLoopback:true,manifest,policy,registry,...expected});
    await assert.rejects(connector.verifyCatalog!(policy.businessId,'orders',manifest.manifestHash,expected.connectionRevision),code('denied',/upstream connection/));
    await assert.rejects(connector.forContext(context).callTool('orders','get_order_status',{order_id:'ORD-1002'}),code('denied',/upstream connection/));
  }
});

test('auto read: own order through sidecar, reviewed fields only; ask/deny not executable', async () => {
  const scoped = integration();
  assert.deepEqual(scoped.tools.map(tool => tool.name), ['get_order_status', 'cancel_order']);
  assert.deepEqual(await scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }),
    { order_id: 'ORD-1001', status: 'paid', total_cents: 49900, currency: 'UAH', tracking_url: null });
  await assert.rejects(scoped.callTool('orders', 'cancel_order', { order_id: 'ORD-1001' }), code('denied', /ledger/));
  await assert.rejects(scoped.callTool('orders', 'delete_customer', {}), code('denied', /operation_disabled/));
  // Cancel was never dispatched upstream.
  assert.equal((await scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }) as { status: string }).status, 'paid');
});

test('foreign order and scope spoofing never reach another customer', async () => {
  const scoped = integration();
  await assert.rejects(scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-2001' }), code('unavailable'));
  await assert.rejects(scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-2001', eldhall: { customerId: TARAS } }), code('invalid_input'));
  await assert.rejects(scoped.callTool('orders', 'get_order_status', { order_id: 'ORD-2001', customer_id: TARAS }), code('invalid_input'));
  const taras = createCatalogIntegration({ businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, manifest, policy })
    .forContext({ ...context, customerId: TARAS });
  assert.equal((await taras.callTool('orders', 'get_order_status', { order_id: 'ORD-2001' }) as { order_id: string }).order_id, 'ORD-2001');
});

test('unreviewed tool, catalog drift and wrong service credential fail closed', async () => {
  const unreviewed = structuredClone(policy); unreviewed.operations[0]!.reviewedOperationHash = 'f'.repeat(64);
  await assert.rejects(integration({ policy: unreviewed }).callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), code('denied', /operation_unreviewed/));
  // Backend reviewed a different manifest than the sidecar serves (same operations, new generator).
  const drifted = structuredClone(manifest); drifted.generatorVersion = 'support-mcp-openapi/9.9.9'; drifted.manifestHash = fingerprint(drifted, 'manifestHash');
  const driftedPolicy = { ...structuredClone(policy), manifestHash: drifted.manifestHash };
  await assert.rejects(integration({ manifest: drifted, policy: driftedPolicy }).callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), code('denied', /manifest does not match/));
  await assert.rejects(integration({ credential: 'wrong-service-token-value' }).callTool('orders', 'get_order_status', { order_id: 'ORD-1001' }), code('unavailable'));
});

test('ask write: snapshot only, then executeAction with idempotency key; replay is safe; guards and stale snapshots fail without effect', async () => {
  const requests: ExternalActionRequest[] = [];
  const scoped = createCatalogIntegration({ businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, manifest, policy })
    .forContext({ ...context, propose: async request => { requests.push(request); return { status: 'awaiting_approval', proposalId: 'p1', summary: request.title }; } });
  const status = async (id: string) => (await scoped.callTool('orders', 'get_order_status', { order_id: id }) as { status: string }).status;
  assert.deepEqual(await scoped.callTool('orders', 'cancel_order', { order_id: 'ORD-1001', reason: 'changed mind' }), { status: 'awaiting_approval', proposalId: 'p1', summary: 'Cancel order' });
  assert.equal(requests[0]!.mode, 'ask');
  assert.equal(requests[0]!.args.customerId, OLENA);
  assert.equal(await status('ORD-1001'), 'paid'); // proposing has no upstream effect

  const actionId = randomUUID();
  const first = await scoped.executeAction!(requests[0]!.args, actionId);
  assert.deepEqual(first, { status: 'executed', data: { order_id: 'ORD-1001', status: 'cancelled' },guard:{id:'orders.cancel_before_shipment',status:'passed'} });
  assert.equal(await status('ORD-1001'), 'cancelled');
  assert.deepEqual(await scoped.executeAction!(requests[0]!.args, actionId), first); // delivery retry: same key, same result
  assert.deepEqual(await scoped.executeAction!(requests[0]!.args, randomUUID()), { status: 'failed', reasonCode: 'conflict',guard:{id:'orders.cancel_before_shipment',status:'unknown'} });

  await scoped.callTool('orders', 'cancel_order', { order_id: 'ORD-1002' });
  assert.deepEqual(await scoped.executeAction!(requests[1]!.args, randomUUID()), { status: 'failed', reasonCode: 'not_cancellable',guard:{id:'orders.cancel_before_shipment',status:'rejected'} }); // shipped
  assert.equal(await status('ORD-1002'), 'shipped');

  const later = createCatalogIntegration({ businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, manifest, policy: { ...policy, policyRevision: 2 } }).forContext(context);
  assert.deepEqual(await later.executeAction!(requests[1]!.args, randomUUID()), { status: 'failed', reasonCode: 'stale_snapshot' });
  const taras = createCatalogIntegration({ businessId: policy.businessId, url: sidecarUrl, credential: serviceToken, allowInsecureLoopback: true, manifest, policy }).forContext({ ...context, customerId: TARAS });
  assert.deepEqual(await taras.executeAction!(requests[0]!.args, randomUUID()), { status: 'failed', reasonCode: 'scope_mismatch' });
  assert.deepEqual(await scoped.executeAction!({ ...requests[1]!.args, input: { order_id: 'ORD-2001' } }, randomUUID()), { status: 'failed', reasonCode: 'ownership_unconfirmed',guard:{id:'orders.cancel_before_shipment',status:'rejected'} });
});

test('live wiring: configured catalog → harness → sidecar: auto read grounds the reply, ask cancel runs only after approve + execute', async () => {
  // Same reviewed manifest/policy, assigned to the seeded business, loaded through the real config schema and factory helper.
  const config = supportConfigSchema.parse({ catalogs: [{ businessId: NOVAPAY, url: sidecarUrl,upstreamTargetFingerprint, credentialEnv: 'ORDERS_SIDECAR_TOKEN', allowInsecureLoopback: true, manifest, policy: { ...policy, businessId: NOVAPAY } }] });
  const integrations = createSupportIntegrations(config, { ORDERS_SIDECAR_TOKEN: serviceToken });
  const store = new MemorySupportStore();
  await store.reset(seedData());
  const decision = (reply: string): AgentDecision => ({ intent: 'other', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply, action: null });
  const model = new ScriptedModel(async ctx => {
    const names = (ctx.businessTools ?? []).map(tool => tool.name);
    if (ctx.message.includes('статус')) {
      const order = await ctx.callBusinessTool!('orders', 'get_order_status', { order_id: 'ORD-1002' }) as { status: string };
      return {...decision(`Замовлення ORD-1002: ${order.status}. Інструменти: ${names.join(', ')}`),intent:'billing_question'};
    }
    await ctx.callBusinessTool!('orders', 'cancel_order', { order_id: 'ORD-1003', reason: 'customer request' });
    return decision('Ваше замовлення скасовано!');
  });
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 10_000, integrations });

  const read = await harness.openCase('demo-olena');
  const status = (await harness.runTurn('demo-olena', read.id, 'Який статус ORD-1002?')).reply!.body;
  assert.equal(status, 'Замовлення ORD-1002: shipped. Інструменти: get_order_status, cancel_order');

  const opened = await harness.openCase('demo-olena');
  const turn = await harness.runTurn('demo-olena', opened.id, 'Скасуйте ORD-1003');
  const proposal = (await store.proposals(opened.id)).find(p => p.tool === 'external_action')!;
  assert.equal(proposal.status, 'pending');
  assert.match(turn.reply!.body, /підготував запит «Cancel order»/);
  const upstreamStatus = async () => (await integrations.forContext({ businessId: NOVAPAY, customerId: OLENA, assertActive: async () => undefined })
    .callTool('orders', 'get_order_status', { order_id: 'ORD-1003' }) as { status: string }).status;
  assert.equal(await upstreamStatus(), 'paid'); // proposing and approving have no upstream effect
  await harness.approve(proposal.id, 'anna', proposal.argsHash);
  assert.equal(await upstreamStatus(), 'paid');
  const executed = await harness.executeApproved(proposal.id, 'anna', proposal.argsHash);
  assert.equal(executed.proposal.status, 'executed');
  assert.equal(await upstreamStatus(), 'cancelled');
  assert.equal((await store.messages(opened.id)).at(-1)!.body, 'Дію «Cancel order» виконано (статус: cancelled).');
  // Another customer of the same business cannot reach Olena's order through the same wiring.
  await assert.rejects(integrations.forContext({ businessId: NOVAPAY, customerId: TARAS, assertActive: async () => undefined }).callTool('orders', 'get_order_status', { order_id: 'ORD-1003' }), code('unavailable'));
});


test('public URL onboarding crosses real managed Python into Auto reads, Ask execution and Deny with restart recovery',{timeout:120000},async t=>{
  const upstreamToken='synthetic-managed-upstream-token',controlToken='synthetic-order-observer';
  const managedToken='synthetic-managed-mcp-service-token-32',operatorToken='synthetic-managed-operator-token';
  const document=await readFile(new URL('openapi.json',orders),'utf8');let specAvailable=true;
  const businessServer=createOrdersApi({token:upstreamToken,customers:{olena:OLENA,taras:TARAS},controlToken}) as Server;
  const upstreamServer=createServer((request,response)=>{
    if(request.url==='/openapi.json'){
      if(request.headers.authorization!==`Bearer ${upstreamToken}`){response.writeHead(401).end();return;}
      if(!specAvailable){response.writeHead(503).end();return;}
      response.writeHead(200,{'content-type':'application/json'}).end(document);return;
    }
    businessServer.emit('request',request,response);
  });
  await new Promise<void>(resolve=>upstreamServer.listen(0,'127.0.0.1',resolve));
  const upstreamUrl=`http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`,managedPort=await freePort(),managerUrl=`http://127.0.0.1:${managedPort}`;
  let managed:ChildProcess|undefined;const app=Fastify();
  const stopManaged=async()=>{
    if(!managed?.pid||managed.exitCode!==null)return;
    const child=managed;const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    if(process.platform==='win32')spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});else process.kill(-child.pid!,'SIGTERM');
    await exited;
  };
  t.after(async()=>{await app.close();await stopManaged();upstreamServer.closeAllConnections();await new Promise<void>(resolve=>upstreamServer.close(()=>resolve()));});
  const startManaged=async()=>{
    const env:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
    Object.assign(env,{HOST:'127.0.0.1',PORT:String(managedPort),MANAGED_ALLOWED_HOSTS:'127.0.0.1,localhost',MANAGED_MCP_TOKEN:managedToken,MANAGED_TEST_UPSTREAM_TOKEN:upstreamToken,MANAGED_UPSTREAM_PROFILES:JSON.stringify({fixture:{name:'Owned synthetic Orders API',principalId:'owned-mcp-fixture',origins:[upstreamUrl],privateOrigins:[upstreamUrl],upstreamBaseUrl:upstreamUrl,tokenEnv:'MANAGED_TEST_UPSTREAM_TOKEN'}})});
    managed=spawn('uv',['run','--quiet','--project',fileURLToPath(new URL('../../mcp-openapi/',import.meta.url)),'support-mcp-managed'],{env,stdio:['ignore','inherit','inherit'],detached:process.platform!=='win32'});
    for(let count=0;count<300;count++){
      if(managed.exitCode!==null)throw Error('Owned managed sidecar exited before readiness');
      if(await fetch(managerUrl+'/health',{signal:AbortSignal.timeout(1000)}).then(response=>response.ok,()=>false))return;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('Owned managed sidecar did not become ready');
  };
  await startManaged();
  const store=new MemorySupportStore(seedData()),client=new ManagedGatewayClient({url:managerUrl,token:managedToken,allowInsecureHttp:true});
  const integrations=withManagedIntegrations(createSupportIntegrations(supportConfigSchema.parse({}),{}),store.integrationStore,client);
  const imports=new IntegrationImportsService(store.integrationStore,client,integrations);
  const model=new ScriptedModel(async context=>{
    if(context.message.includes('статус')){const value=await context.callBusinessTool!('url-orders','get_order_status',{order_id:'ORD-1002'}) as {status:string};return {intent:'billing_question',summary:'Observed order state',reasoning:'The scoped business read returned this status',sentiment:{label:'calm',urgency:'low'},reply:`Зафіксований статус: ${value.status}.`,action:null};}
    await context.callBusinessTool!('url-orders','cancel_order',{order_id:'ORD-1003',reason:'Customer requested cancellation'});return {intent:'other',summary:'Cancellation request',reasoning:'Specialist review required',sentiment:{label:'calm',urgency:'low'},reply:'Order was cancelled!',action:null};
  });
  const harness=new SupportHarness({store,model,fallback:new RulesModel(),provider:new SimulatedPaymentProvider(),timeoutMs:15000,integrations});
  await app.register(supportRoutes,{support:{store,harness,integrations,integrationImports:imports,workspaceBusinessId:NOVAPAY},operatorToken,demoResetEnabled:false});
  const headers={authorization:`Bearer ${operatorToken}`},query='?businessId='+NOVAPAY;
  const preview=await app.inject({method:'POST',url:'/api/v1/integration-imports/prepare'+query,headers,payload:{integrationId:'url-orders',specUrl:upstreamUrl+'/openapi.json',credentialProfileId:'fixture'}});
  assert.equal(preview.statusCode,200,preview.body);const draft=preview.json();assert.equal('spec' in draft,false);assert.ok(draft.operations.every((row:{mode:string;proposedEffect:string})=>row.mode==='deny'&&row.proposedEffect==='unknown'));
  const operations=manifest.operations.filter(operation=>operation.effect!=='unknown').map(operation=>({operationKey:operation.operationKey,mode:operation.toolName==='get_order_status'?'auto':'ask',review:{effect:operation.effect,scope:operation.scope,outputFields:operation.outputFields,guard:operation.guard,idempotency:operation.idempotency,reconciliation:operation.reconciliation}}));
  const connected=await app.inject({method:'POST',url:'/api/v1/integration-imports/'+draft.id+'/confirm'+query,headers,payload:{version:draft.version,specHash:draft.specHash,operations}});
  assert.equal(connected.statusCode,200,connected.body);assert.equal(connected.json().activation,'active');assert.equal(connected.json().runtime,'ready');
  const catalog=await app.inject({url:'/api/v1/integrations/url-orders/operations'+query,headers});assert.equal(catalog.statusCode,200);assert.equal(catalog.json().operations.length,2);assert.ok(catalog.json().unavailableOperations.length>0);
  const readCase=await harness.openCase('demo-olena'),read=await harness.runTurn('demo-olena',readCase.id,'Який статус ORD-1002?');assert.equal(read.reply!.body,'Зафіксований статус: shipped.');assert.equal((await store.proposals(readCase.id)).length,0);
  const clean=await integrations.forContext({businessId:NOVAPAY,customerId:OLENA,assertActive:async()=>undefined}).callTool('url-orders','get_order_status',{order_id:'ORD-1001'});assert.equal('internal_note' in (clean as object),false);
  let current=(await store.integrationStore.get(NOVAPAY,'url-orders'))!;
  const denied=await app.inject({method:'PATCH',url:'/api/v1/integrations/url-orders/policy'+query,headers,payload:{version:current.version,operations:[{operationKey:operations[0]!.operationKey,mode:'deny'}]}});assert.equal(denied.statusCode,200);
  await assert.rejects(integrations.forContext({businessId:NOVAPAY,customerId:OLENA,assertActive:async()=>undefined}).callTool('url-orders','get_order_status',{order_id:'ORD-1001'}),code('denied'));
  current=(await store.integrationStore.get(NOVAPAY,'url-orders'))!;assert.equal((await app.inject({method:'PATCH',url:'/api/v1/integrations/url-orders/policy'+query,headers,payload:{version:current.version,manifestHash:current.loadedManifestHash,operations:[{operationKey:operations[0]!.operationKey,operationHash:manifest.operations.find(row=>row.operationKey===operations[0]!.operationKey)!.operationHash,mode:'auto'}]}})).statusCode,200);
  const observed=async()=>fetch(upstreamUrl+'/__test/orders/ORD-1003',{headers:{'x-test-control':controlToken}}).then(response=>response.json()) as Promise<{status:string;writes:number}>;
  const actionCase=await harness.openCase('demo-olena'),pending=await harness.runTurn('demo-olena',actionCase.id,'Скасуйте моє замовлення ORD-1003');const proposal=(await store.proposals(actionCase.id)).find(row=>row.tool==='external_action')!;
  assert.equal(proposal.status,'pending');assert.doesNotMatch(pending.reply!.body,/Order was cancelled/);assert.equal((await observed()).writes,0);
  const approve=await app.inject({method:'POST',url:'/api/v1/proposals/'+proposal.id+'/approve',headers,payload:{argsHash:proposal.argsHash}});assert.equal(approve.statusCode,200,approve.body);assert.equal((await observed()).writes,0);
  const execute=await app.inject({method:'POST',url:'/api/v1/proposals/'+proposal.id+'/execute',headers,payload:{argsHash:proposal.argsHash}});assert.equal(execute.statusCode,200,execute.body);assert.equal((await observed()).writes,1);assert.equal((await observed()).status,'cancelled');
  assert.equal((await app.inject({method:'POST',url:'/api/v1/proposals/'+proposal.id+'/execute',headers,payload:{argsHash:proposal.argsHash}})).statusCode,409);assert.equal((await observed()).writes,1);
  await stopManaged();specAvailable=false;await startManaged();
  const restored=await integrations.forContext({businessId:NOVAPAY,customerId:OLENA,assertActive:async()=>undefined}).callTool('url-orders','get_order_status',{order_id:'ORD-1003'}) as {status:string};assert.equal(restored.status,'cancelled');assert.equal((await observed()).writes,1);
});
