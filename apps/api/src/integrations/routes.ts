import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { staffTokenMatches } from '../core/auth.js';
import { HarnessError } from '../modules/agent/harness.js';
import { VersionConflict } from '../modules/support/store.js';
import type { SupportDependencies } from '../modules/support/routes.js';
import { IntegrationConflict, effectivePolicy, type IntegrationState } from './state.js';
import { integrationPolicySchema, resolveWithPolicy } from './permissions.js';
import { IntegrationError, projectOutput } from './mcp.js';

const ruleMode=z.enum(['auto','ask','deny','inherit']);
const version=z.number().int().positive();
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const operationKey=z.string().min(1).max(510);
export const integrationSummary=(state:IntegrationState)=>({businessId:state.businessId,integrationId:state.integrationId,enabled:state.enabled,draining:state.draining,
  activeManifestHash:state.activeManifestHash,loadedManifestHash:state.loadedManifestHash,connectionRevision:state.connectionRevision,
  policyRevision:state.policy.policyRevision,defaultMode:state.policy.defaultMode,version:state.version,updatedAt:state.updatedAt});
const response=(state:IntegrationState)=>({integration:integrationSummary(state),policy:state.policy});

export async function integrationRoutes(app:FastifyInstance,{support,operatorToken}:{support:SupportDependencies;operatorToken:string}) {
  const registry=support.store.integrationStore;
  app.addHook('onRequest',async(request,reply)=>{ if(!staffTokenMatches(request.headers.authorization,operatorToken)) return reply.code(401).header('WWW-Authenticate','Bearer').send({detail:'Invalid operator token'}); });
  const guarded=async(reply:FastifyReply,run:()=>Promise<unknown>)=>{
    try{return await run();}catch(error){
      if(error instanceof z.ZodError) return reply.code(422).send({detail:error.issues.map(issue=>issue.message).join('; ')});
      if(error instanceof IntegrationConflict||error instanceof VersionConflict) return reply.code(409).send({detail:error.message});
      if(error instanceof HarnessError) return reply.code(error.status).send({detail:error.message});
      if(error instanceof IntegrationError) return reply.code(409).send({detail:'Catalog readiness verification failed'});
      throw error;
    }
  };
  const business=async(query:unknown)=>{
    const {businessId}=z.object({businessId:z.string().uuid()}).strict().parse(query);
    if(!await support.store.business(businessId)) throw new HarnessError(404,'Business not found');return businessId;
  };
  const selected=async(query:unknown,params:unknown)=>{
    const businessId=await business(query);const {id}=z.object({id:z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/)}).strict().parse(params);
    const state=await registry.get(businessId,id);if(!state) throw new HarnessError(404,'Integration not found');return state;
  };
  const loaded=async(state:IntegrationState,manifestHash=state.loadedManifestHash)=>{
    const manifest=await registry.manifest(state.businessId,state.integrationId,manifestHash);
    if(!manifest) throw new HarnessError(404,'Manifest not found');return manifest;
  };
  app.get('/api/v1/integrations',(request,reply)=>guarded(reply,async()=>({integrations:(await registry.list(await business(request.query))).map(integrationSummary)})));
  app.get('/api/v1/integrations/:id/policy',(request,reply)=>guarded(reply,async()=>response(await selected(request.query,request.params))));
  app.get('/api/v1/integrations/:id/audit',(request,reply)=>guarded(reply,async()=>{const state=await selected(request.query,request.params);return {events:await registry.events(state.businessId,state.integrationId)};}));
  app.get('/api/v1/integrations/:id/operations',(request,reply)=>guarded(reply,async()=>{
    const state=await selected(request.query,request.params);const manifest=await loaded(state);
    return {integration:integrationSummary(state),groups:state.policy.groups,operations:manifest.operations.map(operation=>{
      const rule=state.policy.operations.find(row=>row.operationKey===operation.operationKey);
      return {...operation,enabled:rule?.enabled??false,reviewedOperationHash:rule?.reviewedOperationHash??null,mode:rule?.mode??'inherit',
        effective:resolveWithPolicy({businessId:state.businessId,integrationId:state.integrationId,manifestHash:manifest.manifestHash,operation},effectivePolicy(state))};
    })};
  }));
  app.patch('/api/v1/integrations/:id/policy',(request,reply)=>guarded(reply,async()=>{
    const state=await selected(request.query,request.params);const manifest=await loaded(state);
    const body=z.object({version,defaultMode:z.enum(['auto','ask','deny']).optional(),groups:integrationPolicySchema.shape.groups.optional(),operations:z.array(z.object({operationKey,mode:ruleMode}).strict()).max(1000).optional()}).strict().parse(request.body);
    if(new Set(body.operations?.map(row=>row.operationKey)).size!==(body.operations?.length??0)) throw new HarnessError(422,'Duplicate operation rule');
    const keys=new Set(manifest.operations.map(op=>op.operationKey));
    if(body.operations?.some(op=>!keys.has(op.operationKey)) || body.groups?.some(group=>'operationKeys' in group.selector && group.selector.operationKeys.some(key=>!keys.has(key)))) throw new HarnessError(422,'Unknown operation');
    const next=await registry.change(state.businessId,state.integrationId,body.version,'operator:staff','integration.policy_updated',current=>{
      const operations=manifest.operations.map(op=>current.policy.operations.find(rule=>rule.operationKey===op.operationKey)??{operationKey:op.operationKey,enabled:false,reviewedOperationHash:null,mode:'inherit' as const});
      for(const change of body.operations??[]){const rule=operations.find(op=>op.operationKey===change.operationKey)!;rule.mode=change.mode;}
      return {...current,policy:integrationPolicySchema.parse({...current.policy,defaultMode:body.defaultMode??current.policy.defaultMode,groups:body.groups??current.policy.groups,operations,policyRevision:current.policy.policyRevision+1})};
    });return response(next);
  }));
  app.post('/api/v1/integrations/:id/review',(request,reply)=>guarded(reply,async()=>{
    const state=await selected(request.query,request.params);
    const body=z.object({version,manifestHash:hash,operations:z.array(z.object({operationKey,operationHash:hash,enabled:z.boolean()}).strict()).min(1).max(1000)}).strict().parse(request.body);
    if(body.manifestHash!==state.loadedManifestHash) throw new IntegrationConflict('Loaded manifest changed');
    const manifest=await loaded(state,body.manifestHash);
    if(new Set(body.operations.map(op=>op.operationKey)).size!==body.operations.length) throw new HarnessError(422,'Duplicate operation review');
    if(body.operations.some(row=>!manifest.operations.some(op=>op.operationKey===row.operationKey&&op.operationHash===row.operationHash&&op.effect!=='unknown'))) throw new HarnessError(422,'Operation hash or reviewed effect does not match');
    const next=await registry.change(state.businessId,state.integrationId,body.version,'operator:staff','integration.reviewed',current=>{
      const operations=manifest.operations.map(op=>{const old=current.policy.operations.find(row=>row.operationKey===op.operationKey);const review=body.operations.find(row=>row.operationKey===op.operationKey);
        return {operationKey:op.operationKey,mode:old?.mode??'inherit' as const,enabled:review?review.enabled:old?.reviewedOperationHash===op.operationHash&&(old?.enabled??false),reviewedOperationHash:review?op.operationHash:old?.reviewedOperationHash===op.operationHash?op.operationHash:null};});
      return {...current,policy:{...current.policy,manifestHash:manifest.manifestHash,operations,policyRevision:current.policy.policyRevision+1}};
    });return response(next);
  }));
  app.post('/api/v1/integrations/:id/activate',(request,reply)=>guarded(reply,async()=>{
    const state=await selected(request.query,request.params);const body=z.object({version,manifestHash:hash,connectionRevision:z.string().regex(/^[1-9]\d{0,14}$/)}).strict().parse(request.body);
    if(body.manifestHash!==state.loadedManifestHash||body.connectionRevision!==state.connectionRevision) throw new IntegrationConflict('Loaded connection or manifest changed');
    if(!support.integrations?.verifyCatalog) throw new IntegrationConflict('Catalog runtime is not loaded');
    await support.integrations.verifyCatalog(state.businessId,state.integrationId,body.manifestHash,body.connectionRevision);
    const next=await registry.change(state.businessId,state.integrationId,body.version,'operator:staff','integration.activated',current=>{
      if(current.policy.manifestHash!==body.manifestHash) throw new IntegrationConflict('Review this manifest before activation');
      return {...current,enabled:true,draining:false,activeManifestHash:body.manifestHash,policy:{...current.policy,enabled:true,policyRevision:current.policy.policyRevision+1}};
    });return response(next);
  }));
  app.post('/api/v1/integrations/:id/disable',(request,reply)=>guarded(reply,async()=>{
    const state=await selected(request.query,request.params);const body=z.object({version,draining:z.boolean().default(true)}).strict().parse(request.body);
    return response(await registry.change(state.businessId,state.integrationId,body.version,'operator:staff','integration.disabled',current=>({...current,enabled:false,draining:body.draining,policy:{...current.policy,enabled:false,policyRevision:current.policy.policyRevision+1}})));
  }));
  app.post<{Params:{id:string}}>('/api/v1/proposals/:id/reconcile',(request,reply)=>guarded(reply,async()=>{
    const {id}=z.object({id:z.string().uuid()}).strict().parse(request.params);
    const body=z.object({status:z.enum(['executed','failed']),reason:z.string().trim().min(3).max(500),providerRef:z.string().min(1).max(200).optional(),result:z.record(z.string(),z.unknown()).optional()}).strict().parse(request.body);
    const proposal=await support.store.proposal(id);if(!proposal||proposal.tool!=='external_action') throw new HarnessError(404,'External action not found');
    if(proposal.status!=='unknown') throw new IntegrationConflict('Only an unknown execution can be reconciled');
    const supportCase=(await support.store.getCase(proposal.caseId))!;
    const manifest=await registry.manifest(supportCase.businessId,String(proposal.args.integrationId),String(proposal.args.manifestHash));
    const operation=manifest?.operations.find(op=>op.operationKey===proposal.args.operationKey);
    if(!operation) throw new IntegrationConflict('Recorded catalog is unavailable');
    const result={...(body.result?{data:projectOutput(body.result,operation.outputFields,8192)}:{}),...(body.providerRef?{providerRef:body.providerRef}:{}),reconciliationReason:body.reason};
    const done=await support.store.finishExternalAction(id,body.status,result,body.status==='failed'?'operator_verified_failure':null,body.status==='executed'?`Спеціаліст перевірив виконання дії «${String(proposal.args.title)}».`:`Спеціаліст підтвердив, що дію «${String(proposal.args.title)}» не виконано.`,'operator:staff',true);
    return {proposal:done,case:(await support.store.getCase(proposal.caseId))!};
  }));
}
