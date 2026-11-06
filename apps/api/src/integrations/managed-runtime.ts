import {createCatalogIntegration} from './catalog.js';
import {IntegrationError,type BusinessIntegrations,type BusinessIntegrationContext,type ScopedBusinessTools} from './mcp.js';
import {managedConnectionSchema} from './imports-contracts.js';
import {ManagedGatewayClient} from './managed-client.js';
import type {IntegrationStore} from './state.js';

/** Both API and worker discover the same durable connections. The sidecar cache is disposable. */
export function withManagedIntegrations(base:BusinessIntegrations,store:IntegrationStore,client:ManagedGatewayClient):BusinessIntegrations{
  const resolve=async(context:BusinessIntegrationContext,id:string,hash?:string):Promise<ScopedBusinessTools|null>=>{
    const state=await store.get(context.businessId,id);if(!state?.managedConnection)return null;
    if(!state.enabled||state.draining)throw new IntegrationError('denied','Managed integration is disabled');
    const connection=managedConnectionSchema.parse(state.managedConnection);
    const manifest=await store.manifest(context.businessId,id,hash??state.loadedManifestHash);if(!manifest)throw new IntegrationError('denied','Recorded managed manifest is unavailable');
    const url=await client.ensure(state,manifest);
    return createCatalogIntegration({businessId:state.businessId,url,credential:client.options.token,allowInsecureLoopback:client.options.allowInsecureHttp,internalHttpOrigins:new URL(url).protocol==='http:'?[new URL(url).origin]:[],connectionRevision:state.connectionRevision,upstreamTargetFingerprint:connection.upstreamTargetFingerprint,manifest,policy:state.policy,registry:store}).forContext(context);
  };
  return {
    async verifyCatalog(businessId,id,hash,revision){
      const state=await store.get(businessId,id);if(!state?.managedConnection){if(!base.verifyCatalog)throw new IntegrationError('denied','Catalog runtime is unavailable');return base.verifyCatalog(businessId,id,hash,revision);}
      if(state.loadedManifestHash!==hash||state.connectionRevision!==revision)throw new IntegrationError('denied','Catalog revision changed');
      const connection=managedConnectionSchema.parse(state.managedConnection),manifest=await store.manifest(businessId,id,hash);if(!manifest)throw new IntegrationError('denied','Manifest is unavailable');
      const url=await client.ensure(state,manifest);return createCatalogIntegration({businessId,url,credential:client.options.token,allowInsecureLoopback:client.options.allowInsecureHttp,internalHttpOrigins:new URL(url).protocol==='http:'?[new URL(url).origin]:[],connectionRevision:revision,upstreamTargetFingerprint:connection.upstreamTargetFingerprint,manifest,policy:state.policy,registry:store}).verifyCatalog!(businessId,id,hash,revision);
    },
    forContext(context){const original=base.forContext(context);return {
      tools:original.tools,
      async listTools(){await context.assertActive();const staticTools=original.listTools?await original.listTools():original.tools;const rows=await store.list(context.businessId);const managed=await Promise.all(rows.filter(row=>row.managedConnection&&row.enabled&&!row.draining).map(async row=>{try{const scoped=await resolve(context,row.integrationId);return scoped?.listTools?await scoped.listTools():scoped?.tools??[];}catch{return [];}}));await context.assertActive();return [...staticTools,...managed.flat()];},
      async callTool(id,name,input,signal){await context.assertActive();const scoped=await resolve(context,id);await context.assertActive();return (scoped??original).callTool(id,name,input,signal);},
      async executeAction(args,id,signal){await context.assertActive();const scoped=await resolve(context,String(args.integrationId),typeof args.manifestHash==='string'?args.manifestHash:undefined);await context.assertActive();return (scoped??original).executeAction?.(args,id,signal)??{status:'failed',reasonCode:'integration_unavailable'};}
    };}
  };
}
