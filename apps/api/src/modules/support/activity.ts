import type { GuardRule } from './guards.js';
import type { AuditEvent, PolicyCheck } from './contracts.js';

export type ActivityFacts = Record<string, string | number | boolean | null | string[]>;
export interface ActivityContext {
  settingsVersion: number; guardRevision:number; skills: { id: string; name: string; revision: number;contentHash:string;preview:string;truncated:boolean;loadedCharacters:number;totalCharacters:number }[];
  guards: GuardRule[];
  provider: string; model: string;
}
export interface AgentActivityEvent {
  id: string; runId: string; sequence:number; turnJobId:string|null; callId: string | null; createdAt: string;
  type: 'context' | 'tool_call' | 'tool_result' | 'decision' | 'fallback' | 'guard';
  tool: string | null; outcome: 'started' | 'succeeded' | 'proposed' | 'denied' | 'failed' | 'unknown' | 'fallback';
  summary: string; reason: string | null; proposalId: string | null; requestIds: string[];
  input: ActivityFacts | null; result: ActivityFacts | null; checks: PolicyCheck[]; context: ActivityContext | null;
}
export interface AgentActivity { status: 'recorded' | 'not_recorded'; events: AgentActivityEvent[]; hasMore: boolean }
export type NewActivity = Omit<AgentActivityEvent, 'id' | 'createdAt' | 'runId' | 'sequence' | 'turnJobId'>;
export function activityFromAudit(rows: AuditEvent[]): AgentActivity {
  const recorded = rows.filter(row => row.type === 'agent.activity');
  const events:AgentActivityEvent[]=[];
  for(const row of rows){
    if(row.type==='agent.activity'){events.push({...row.data,id:row.id,createdAt:row.createdAt} as unknown as AgentActivityEvent);continue;}
    if(row.type!=='guard.evaluated'||typeof row.data.proposalId!=='string'||typeof row.data.allowed!=='boolean'||!Array.isArray(row.data.checks)||!Array.isArray(row.data.guards))continue;
    const related=recorded.find(event=>event.data.proposalId===row.data.proposalId);if(!related||typeof related.data.runId!=='string')continue;
    const previous=events.filter(event=>event.runId===related.data.runId);const context=previous.find(event=>event.type==='context')?.context;
    const checks=row.data.checks as PolicyCheck[];
    events.push({...activity('guard','Server-side guard evaluation at action admission',{outcome:row.data.allowed?'succeeded':'denied',proposalId:row.data.proposalId,requestIds:Array.isArray(related.data.requestIds)?related.data.requestIds.filter((id):id is string=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)):[],checks,reason:checks.find(check=>!check.passed)?.detail??null,context:context?{...context,guardRevision:Number(row.data.guardRevision??0),settingsVersion:Number(row.data.settingsVersion??context.settingsVersion),guards:row.data.guards as GuardRule[]}:null}),id:row.id,createdAt:row.createdAt,runId:related.data.runId,sequence:Math.max(0,...previous.map(event=>event.sequence))+1,turnJobId:typeof related.data.turnJobId==='string'?related.data.turnJobId:null});
  }
  const sequence=new Map<string,number>();const ordered=events.map(event=>{const next=(sequence.get(event.runId)??0)+1;sequence.set(event.runId,next);return {...event,sequence:next};});
  return { status: ordered.length ? 'recorded' : 'not_recorded', events:ordered.slice(-100), hasMore:ordered.length>100 };
}

export function activity(type:NewActivity['type'],summary:string,extra:Partial<NewActivity>={}):NewActivity {
  return {type,summary,outcome:'succeeded',callId:null,tool:null,reason:null,proposalId:null,requestIds:[],input:null,result:null,checks:[],context:null,...extra};
}
export function safeToolFacts(tool:string,args:Record<string,unknown>):ActivityFacts {
  if(tool==='search_knowledge')return {queryLength:typeof args.query==='string'?args.query.length:0};
  if(tool==='lookup_payments')return {limit:Number.isInteger(args.limit)?Number(args.limit):10};
  if(tool==='update_customer_requests')return {changes:Array.isArray(args.changes)?args.changes.length:0};
  if(tool==='submit_decision'&&args.action&&typeof args.action==='object'){
    const action=args.action as Record<string,unknown>;const input=action.args as Record<string,unknown>|undefined;const facts:ActivityFacts={};
    if(['refund_payment','escalate_to_human'].includes(String(action.tool)))facts.action=String(action.tool);
    if(action.tool==='refund_payment'&&input){if(typeof input.payment_id==='string'&&/^[a-f0-9-]{36}$/i.test(input.payment_id))facts.requestedPaymentId=input.payment_id;if(Number.isSafeInteger(input.amount_cents)&&Number(input.amount_cents)>0)facts.requestedAmountCents=Number(input.amount_cents);}
    return facts;
  }
  const facts:ActivityFacts={};
  for(const key of ['integrationId','name'])if(typeof args[key]==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(args[key]))facts[key]=args[key];
  if(Array.isArray(args.requests))facts.requestCount=args.requests.length;
  return facts;
}
export function safeToolResult(value:unknown):ActivityFacts {
  if(!value||typeof value!=='object')return {recorded:true};
  const row=value as Record<string,unknown>;const facts:ActivityFacts={};
  if(typeof row.status==='string'&&['awaiting_approval','executed','denied','failed','unknown','shipped','paid','cancelled','canceled','captured','refunded','confirmed','delivered','scheduled','active','suspended','pending','in_transit'].includes(row.status))facts.status=row.status;
  if(typeof row.reasonCode==='string'&&/^[a-z0-9_.-]{1,100}$/i.test(row.reasonCode))facts.reasonCode=row.reasonCode;
  if(typeof row.actionId==='string'&&/^[a-f0-9-]{36}$/i.test(row.actionId))facts.proposalId=row.actionId;
  if(typeof row.proposalId==='string'&&/^[a-f0-9-]{36}$/i.test(row.proposalId))facts.proposalId=row.proposalId;
  if(Number.isSafeInteger(row.amount_cents)&&typeof row.currency==='string'&&/^[A-Z]{3}$/.test(row.currency)){facts.amountCents=Number(row.amount_cents);facts.currency=row.currency;}
  for(const key of ['payments','sources'])if(Array.isArray(row[key]))facts[key+'Count']=row[key].length;
  if(Array.isArray(row.payments))row.payments.slice(0,10).forEach((value,index)=>{if(!value||typeof value!=='object')return;const payment=value as Record<string,unknown>;if(typeof payment.id!=='string'||!/^[a-f0-9-]{36}$/i.test(payment.id)||!Number.isSafeInteger(payment.amountCents)||typeof payment.currency!=='string'||!/^[A-Z]{3}$/.test(payment.currency)||!['captured','refunded'].includes(String(payment.status)))return;if(Object.keys(facts).length+4>39){facts.omitted=true;return;}const key='payment'+(index+1);facts[key+'Id']=payment.id;facts[key+'AmountCents']=Number(payment.amountCents);facts[key+'Currency']=payment.currency;facts[key+'Status']=String(payment.status);});
  if(Array.isArray(row.sources))row.sources.slice(0,10).forEach((value,index)=>{if(!value||typeof value!=='object')return;const source=value as Record<string,unknown>;if(typeof source.id!=='string'||!/^[a-f0-9-]{36}$/i.test(source.id))return;if(Object.keys(facts).length+3>39){facts.omitted=true;return;}const key='source'+(index+1);facts[key+'Id']=source.id;if(typeof source.title==='string')facts[key+'Title']=source.title.slice(0,160);if(Number.isSafeInteger(source.version))facts[key+'Version']=Number(source.version);});
  if(row.requestCatalog&&typeof row.requestCatalog==='object')facts.requestCount=Array.isArray((row.requestCatalog as Record<string,unknown>).requests)?((row.requestCatalog as Record<string,unknown>).requests as unknown[]).length:0;
  if(!Object.keys(facts).length)facts.recorded=true;
  const entries=Object.entries(facts);
  return entries.length>40?{...Object.fromEntries(entries.filter(([key])=>key!=='omitted').slice(0,39)),omitted:true}:facts;
}
