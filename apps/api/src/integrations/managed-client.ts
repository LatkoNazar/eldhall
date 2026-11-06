import {fingerprint} from './permissions.js';
import { z } from 'zod';
import { capabilitiesSchema,managedConnectionSchema,preparedControlSchema,type ManagedConnection } from './imports-contracts.js';
import { manifestSchema,type Manifest } from './manifest.js';
import type { IntegrationState } from './state.js';

export interface ManagedSupportOptions {url:string;token:string;allowInsecureHttp:boolean}
export class ManagedImportError extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);this.name='ManagedImportError';}}
export function getManagedSupportOptions(env:NodeJS.ProcessEnv):ManagedSupportOptions|undefined{
  if(!env.MANAGED_MCP_URL&&!env.MANAGED_MCP_TOKEN)return undefined;
  const token=env.MANAGED_MCP_TOKEN??'';let url:URL;
  try{url=new URL(env.MANAGED_MCP_URL??'');}catch{throw Error('Invalid managed MCP configuration');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  const insecure=env.MANAGED_MCP_ALLOW_INSECURE_HTTP==='true';
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&!loopback&&!insecure)||token.length<24||token.length>4096||/[^\x21-\x7e]/.test(token))throw Error('Invalid managed MCP configuration');
  return {url:url.origin,token,allowInsecureHttp:insecure||loopback};
}
const publicProblems:Record<string,{status:number;detail:string}>={
 openapi_json_required:{status:422,detail:'Use a direct OpenAPI JSON URL, not a Swagger or documentation page'},
 invalid_url:{status:422,detail:'Use a valid HTTP(S) URL without credentials, query or fragment'},
 profile_target_mismatch:{status:422,detail:'Use the fixed upstream base configured for the selected credential profile'},
 response_too_large:{status:413,detail:'The OpenAPI source exceeds its permitted response size'},
 response_headers_too_large:{status:413,detail:'The OpenAPI source returned oversized response headers'},
 encoded_response_refused:{status:422,detail:'The OpenAPI source must return uncompressed JSON'},
 egress_busy:{status:503,detail:'The connector network service is busy; retry shortly'},
 spec_unavailable:{status:502,detail:'The OpenAPI document could not be downloaded from the selected URL'},
 upstream_unavailable:{status:502,detail:'The selected upstream service is unavailable'},
 connection_unavailable:{status:502,detail:'The selected upstream connection is unavailable'},
 address_blocked:{status:403,detail:'This network address is not permitted for OpenAPI connections'},
 https_required:{status:422,detail:'Use HTTPS unless an exact private origin has been configured'},
 profile_origin_mismatch:{status:422,detail:'The selected credential profile does not permit this origin'},
 credential_profile_unavailable:{status:422,detail:'The selected credential profile is unavailable'},
 spec_unauthorized:{status:422,detail:'The OpenAPI document requires authorization permitted by its selected profile'},
 redirect_refused:{status:422,detail:'Use the direct OpenAPI document URL without a redirect'},
 unsupported_schema:{status:422,detail:'The OpenAPI schema is outside the supported bounded profile'},
 invalid_openapi_or_review:{status:422,detail:'The OpenAPI document or explicit operation review is invalid'},
 compiler_busy:{status:503,detail:'The OpenAPI compiler is busy; retry this preparation'},
 runtime_missing:{status:503,detail:'The managed catalog runtime is unavailable; retry installation'},
};
async function responseJson(response:Response,maximum:number):Promise<unknown>{
 const reader=response.body?.getReader();if(!reader)throw Error();let size=0;const chunks:Uint8Array[]=[];
 while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>maximum){await reader.cancel();throw Error();}chunks.push(next.value);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
const runtimeSchema=z.object({ready:z.literal(true),manifestHash:z.string(),connectionRevision:z.string(),upstreamTargetFingerprint:z.string(),mcpPath:z.string()});
export class ManagedGatewayClient {
  readonly options:ManagedSupportOptions;
  constructor(options:ManagedSupportOptions,private readonly fetcher:typeof fetch=fetch){const checked=getManagedSupportOptions({MANAGED_MCP_URL:options.url,MANAGED_MCP_TOKEN:options.token,MANAGED_MCP_ALLOW_INSECURE_HTTP:String(options.allowInsecureHttp)});if(!checked)throw Error('Invalid managed MCP configuration');this.options=checked;}
  async request(path:string,body?:unknown,missing=false):Promise<unknown>{
    try{
      const response=await this.fetcher(new URL(path,this.options.url),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(['/control/prepare','/control/compile'].includes(path)?30000:15000),headers:{authorization:`Bearer ${this.options.token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(missing&&response.status===404){await response.body?.cancel();return null;}
      if(!response.ok){
        const problem=await responseJson(response,4096).catch(()=>null);
        const code=problem&&typeof problem==='object'&&'code' in problem&&typeof problem.code==='string'?problem.code:'';
        const known=Object.hasOwn(publicProblems,code)?publicProblems[code]:undefined;
        if(known)throw new ManagedImportError(known.status,code,known.detail);
        throw new ManagedImportError(response.status===409?409:response.status>=400&&response.status<500&&![401,403].includes(response.status)?422:503,'managed_request_refused','Managed OpenAPI request was refused');
      }
      return responseJson(response,8_000_000);
    }catch(error){if(error instanceof ManagedImportError)throw error;throw new ManagedImportError(503,'managed_unavailable','Managed OpenAPI service is unavailable');}
  }
  async capabilities(){return capabilitiesSchema.parse(await this.request('/control/capabilities'));}
  async prepare(body:unknown){return preparedControlSchema.parse(await this.request('/control/prepare',body));}
  async compile(body:unknown){return z.object({manifest:manifestSchema,report:z.unknown(),upstreamTargetFingerprint:z.string(),principalId:z.string()}).parse(await this.request('/control/compile',body));}
  private pending=new Map<string,Promise<string>>();
  ensure(state:IntegrationState,manifest:Manifest):Promise<string>{
    const connection=managedConnectionSchema.parse(state.managedConnection);
    if(connection.upstreamTargetFingerprint!==fingerprint({baseUrl:new URL(connection.upstreamBaseUrl).href.replace(/\/+$/,''),principalId:connection.principalId})||state.connectionHash!==fingerprint({upstreamBaseUrl:connection.upstreamBaseUrl,credentialProfileId:connection.credentialProfileId,upstreamTargetFingerprint:connection.upstreamTargetFingerprint}))throw new ManagedImportError(503,'connection_mismatch','Stored managed connection identity differs');
    const key=[state.businessId,state.integrationId,state.connectionRevision,manifest.manifestHash].join('/');
    const existing=this.pending.get(key);if(existing)return existing;
    const work=this.ensureNow(state,manifest,connection).finally(()=>this.pending.delete(key));this.pending.set(key,work);return work;
  }
  private async ensureNow(state:IntegrationState,manifest:Manifest,connection:ManagedConnection){
    const identity={businessId:state.businessId,integrationId:state.integrationId,connectionRevision:state.connectionRevision,manifestHash:manifest.manifestHash};
    const status=await this.request('/control/status',identity,true);
    const data=runtimeSchema.parse(status??await this.request('/control/install',{businessId:state.businessId,integrationId:state.integrationId,connectionRevision:state.connectionRevision,manifest,upstreamBaseUrl:connection.upstreamBaseUrl,credentialProfileId:connection.credentialProfileId,upstreamTargetFingerprint:connection.upstreamTargetFingerprint}));
    const path=`/managed/${state.businessId}/${state.integrationId}/${state.connectionRevision}/${manifest.manifestHash}/mcp`;
    if(data.manifestHash!==manifest.manifestHash||data.connectionRevision!==state.connectionRevision||data.upstreamTargetFingerprint!==connection.upstreamTargetFingerprint||data.mcpPath!==path)throw new ManagedImportError(503,'runtime_mismatch','Managed catalog runtime identity differs');
    return new URL(path,this.options.url).href;
  }
}
