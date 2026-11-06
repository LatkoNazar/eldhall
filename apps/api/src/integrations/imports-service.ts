import {randomUUID} from 'node:crypto';
import {confirmImportSchema,importDraftSchema,managedConnectionSchema,prepareImportSchema,publicDraft,type ImportDraft} from './imports-contracts.js';
import {fingerprint,integrationPolicySchema} from './permissions.js';
import {IntegrationConflict,type IntegrationState,type IntegrationStore} from './state.js';
import {ManagedGatewayClient,ManagedImportError} from './managed-client.js';
import type {BusinessIntegrations} from './mcp.js';

export class IntegrationImportsService {
  constructor(private readonly store:IntegrationStore,readonly client:ManagedGatewayClient,private readonly runtime:BusinessIntegrations){}
  async capabilities(){return {enabled:true,...await this.client.capabilities(),maxSpecBytes:5_000_000};}
  async prepare(businessId:string,raw:unknown){
    const input=prepareImportSchema.parse(raw);
    if((await this.store.list(businessId)).length>=20)throw new IntegrationConflict('Integration catalog limit reached');
    if(await this.store.get(businessId,input.integrationId))throw new IntegrationConflict('Integration id already exists');
    const capabilities=await this.client.capabilities();
    const profile=capabilities.credentialProfiles.find(row=>row.id===input.credentialProfileId);
    if(!profile?.configured)throw new ManagedImportError(422,'credential_profile_unavailable','Selected credential profile is unavailable');
    if(profile.upstreamBaseUrl&&input.upstreamBaseUrl&&new URL(profile.upstreamBaseUrl).href.replace(/\/$/,'')!==new URL(input.upstreamBaseUrl).href.replace(/\/$/,''))throw new ManagedImportError(422,'profile_target_mismatch','Selected profile belongs to another upstream');
    const prepared=await this.client.prepare(input);
    if((input.upstreamBaseUrl&&new URL(input.upstreamBaseUrl).href.replace(/\/+$/,'')!==new URL(prepared.upstreamBaseUrl).href.replace(/\/+$/,''))||prepared.upstreamTargetFingerprint!==fingerprint({baseUrl:new URL(prepared.upstreamBaseUrl).href.replace(/\/+$/,''),principalId:prepared.principalId})||prepared.credentialProfileId!==input.credentialProfileId||(profile.upstreamBaseUrl&&new URL(profile.upstreamBaseUrl).href.replace(/\/$/,'')!==new URL(prepared.upstreamBaseUrl).href.replace(/\/$/,''))||fingerprint(prepared.spec)!==prepared.specHash)throw new ManagedImportError(503,'prepared_identity_mismatch','Prepared OpenAPI identity differs');
    if(new Set(prepared.operations.map(row=>row.operationKey)).size!==prepared.operations.length)throw new ManagedImportError(503,'duplicate_inventory','Prepared operation inventory is invalid');
    const draft:ImportDraft={id:randomUUID(),businessId,version:1,expiresAt:new Date(Date.now()+30*60_000).toISOString(),status:'prepared',integrationId:input.integrationId,source:input,prepared,confirmationHash:null};
    await this.store.createImport(draft);return publicDraft(draft);
  }
  async draft(businessId:string,id:string){const stored=await this.store.importDraft(businessId,id);if(!stored)throw new ManagedImportError(404,'import_not_found','Prepared import was not found');const parsed=importDraftSchema.safeParse(stored);if(!parsed.success)throw new ManagedImportError(409,'invalid_import','Stored import is invalid');const draft=parsed.data;if(draft.id!==id||draft.businessId!==businessId||draft.source.integrationId!==draft.integrationId)throw new ManagedImportError(409,'invalid_import','Stored import identity differs');if(draft.status==='prepared'&&Date.parse(draft.expiresAt)<=Date.now())throw new IntegrationConflict('Prepared import expired');return draft;}
  async confirm(businessId:string,id:string,raw:unknown){
    const body=confirmImportSchema.parse(raw),draft=await this.draft(businessId,id),confirmationHash=fingerprint(body);
    if(draft.prepared.specHash!==body.specHash)throw new IntegrationConflict('Prepared OpenAPI changed');
    let state:IntegrationState;
    if(draft.status==='confirmed'){
      if(draft.confirmationHash!==confirmationHash)throw new IntegrationConflict('Import was confirmed with different input');
      const existing=await this.store.get(businessId,draft.integrationId);if(!existing)throw new IntegrationConflict('Confirmed integration is unavailable');state=existing;
    }else{
      if(body.version!==draft.version)throw new IntegrationConflict('Import version changed');
      const selected=body.operations.filter(row=>row.mode!=='deny'||row.review);
      const operations=Object.fromEntries(selected.map(row=>{
        const candidate=draft.prepared.operations.find(candidate=>candidate.operationKey===row.operationKey);
        if(!candidate?.supported||!row.review)throw new ManagedImportError(422,'operation_not_supported','Selected operation needs a supported explicit review');
        return [row.operationKey,row.review];
      }));
      if(body.operations.some(row=>!draft.prepared.operations.some(candidate=>candidate.operationKey===row.operationKey)))throw new ManagedImportError(422,'unknown_operation','Operation is not in the prepared snapshot');
      const compiled=await this.client.compile({spec:draft.prepared.spec,integrationId:draft.integrationId,upstreamBaseUrl:draft.prepared.upstreamBaseUrl,credentialProfileId:draft.prepared.credentialProfileId,review:{operations}});
      const manifest=compiled.manifest;
      if(manifest.integrationId!==draft.integrationId||manifest.specHash!==draft.prepared.specHash||compiled.upstreamTargetFingerprint!==draft.prepared.upstreamTargetFingerprint||compiled.principalId!==draft.prepared.principalId||manifest.operations.length!==selected.length||selected.some(row=>!manifest.operations.some(operation=>operation.operationKey===row.operationKey)))throw new ManagedImportError(422,'review_not_compilable','Reviewed operations could not be compiled exactly');
      for(const selection of selected){
        const actual=manifest.operations.find(operation=>operation.operationKey===selection.operationKey)!;
        const expected={...selection.review!,guard:selection.review!.guard??null,idempotency:selection.review!.idempotency??null,reconciliation:selection.review!.reconciliation??null};
        const controlled={effect:actual.effect,scope:actual.scope,outputFields:actual.outputFields,guard:actual.guard,idempotency:actual.idempotency,reconciliation:actual.reconciliation};
        if(fingerprint(expected)!==fingerprint(controlled))throw new ManagedImportError(422,'compiled_review_mismatch','Compiled operation differs from the explicit operator review');
      }
      const policy=integrationPolicySchema.parse({integrationId:draft.integrationId,businessId,enabled:false,manifestHash:manifest.manifestHash,policyRevision:1,defaultMode:'deny',groups:[],operations:manifest.operations.map(operation=>{const selection=body.operations.find(row=>row.operationKey===operation.operationKey)!;return {operationKey:operation.operationKey,enabled:selection.mode!=='deny',reviewedOperationHash:selection.mode==='deny'?null:operation.operationHash,mode:selection.mode};})});
      const connection=managedConnectionSchema.parse({kind:'managed',sourceUrl:draft.source.specUrl,upstreamBaseUrl:draft.prepared.upstreamBaseUrl,credentialProfileId:draft.prepared.credentialProfileId,principalId:draft.prepared.principalId,upstreamTargetFingerprint:draft.prepared.upstreamTargetFingerprint,importId:draft.id,inventory:draft.prepared.operations});
      state=await this.store.registerImport(businessId,id,body.version,confirmationHash,{businessId,manifest,policy,connectionRevision:'1',connectionHash:fingerprint({upstreamBaseUrl:connection.upstreamBaseUrl,credentialProfileId:connection.credentialProfileId,upstreamTargetFingerprint:connection.upstreamTargetFingerprint})},connection);
    }
    let ready=false;
    try{await this.runtime.verifyCatalog!(businessId,state.integrationId,state.loadedManifestHash,state.connectionRevision);ready=true;}catch{ /* The saved integration remains disabled and can be retried using the same confirmation. */ }
    if(ready&&state.onboardingPending){
      try{state=await this.store.change(businessId,state.integrationId,state.version,'operator:staff','integration.activated',current=>({...current,enabled:true,draining:false,activeManifestHash:current.loadedManifestHash,policy:{...current.policy,enabled:true,policyRevision:current.policy.policyRevision+1}}));}
      catch(error){const fresh=await this.store.get(businessId,state.integrationId);if(!(error instanceof IntegrationConflict)||!fresh||fresh.onboardingPending||fresh.managedConnection?.importId!==id)throw error;state=fresh;}
    }
    return {state,runtime:ready?'ready' as const:'unavailable' as const,activation:state.enabled?'active' as const:'disabled' as const};
  }
}
