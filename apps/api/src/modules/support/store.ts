import { evaluateGuards, guardPolicyUpdate } from './guards.js';
import { databasePolicyUpdate } from './database-guards.js';
import { requestCheckpointSchema } from './requests/contracts.js';
import { hasUnrepresentedInput, isAcknowledgement } from './requests/text.js';
import type { RequestCatalog, RequestCheckpoint, RequestEvent, RequestTarget, RequestTransition } from './requests/contracts.js';
import { actionAllowed, aggregateRequestStatus, applyCheckpoint, emptyCatalog, linkAction, publicCatalog, transitionRequest } from './requests/engine.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AcceptedTurn, AgentRun, AuditEvent, Business, CaseStatus, Customer, KnowledgeSource, Message, MessageRole, Metrics, Payment, Priority, Proposal, ProposalStatus, Refund, SupportCase, SupportSettings, SupportSkill, SupportTurnJob, TurnLease } from './contracts.js';
import type { SeedData } from './seed.js';
import { sameClassificationConfig } from '../agent/classification.js';
import { canReplaceClassification, classificationState, storedClassification, visibleClassification, type ClassificationState, type StoredClassification } from './classification-storage.js';
import { MemoryIntegrationStore, externalAdmissionReason, type IntegrationStore } from '../../integrations/state.js';
type StoredSettings = Omit<SupportSettings, 'classification'> & { classification?: StoredClassification };

export type NewProposal = Omit<Proposal, 'id' | 'createdAt' | 'decidedBy' | 'decidedAt' | 'result' | 'error'>;
export type CasePatch = Partial<Pick<SupportCase, 'status' | 'priority' | 'intent' | 'analysis' | 'ownership' | 'assignedTo'>>;
export interface TurnContext { policy: Business['policy']; skills: { id: string; revision: number }[]; settingsVersion?:number; classification?: SupportSettings['classification']; externalSourceRefs?: Message['externalSourceRefs']; completionActionId?: string; integrationRefs?: { integrationId:string;manifestHash:string;connectionRevision:string;policyRevision:number }[] }
export class DuplicateRefund extends Error {}
export class StaleTurn extends Error {}
/** Tools a policy may run without operator approval: pending -> executing by `agent:auto`,
 * and only when the proposal was recorded as not requiring approval (`ask` stays with the operator). */
export const AUTO_CLAIMABLE = ['escalate_to_human', 'external_action'];
export class VersionConflict extends Error {}
export interface SupportStore {
  requestCatalog(caseId: string): Promise<RequestCatalog>;
  requestCheckpoint(lease: TurnLease, sourceMessageId: string, batch: RequestCheckpoint): Promise<RequestCatalog>;
  requestTransition(caseId: string, requestId: string, change: RequestTransition, actor: string): Promise<RequestCatalog>;
  readonly integrationStore: IntegrationStore;
  markExternalDispatched(id: string): Promise<boolean>;
  finishExternalAction(id: string, status: 'executed' | 'failed' | 'unknown', result: Record<string, unknown> | null, error: string | null, message: string | null, actor: string, reconciliation?: boolean): Promise<Proposal>;
  expireExternalActions(caseId?: string,businessId?:string): Promise<void>;
  reset(seed: SeedData): Promise<void>;
  seedIfEmpty(seed: SeedData): Promise<void>;
  recoverInterruptedExecutions(businessId?:string): Promise<void>;
  businessesList(): Promise<Business[]>;
  createBusiness(business: Business): Promise<Business>;
  createCustomer(customer: Customer): Promise<Customer>;
  customerBySession(token: string): Promise<Customer | null>;
  customer(id: string): Promise<Customer | null>;
  business(id: string): Promise<Business | null>;
  payments(customerId: string, limit?: number): Promise<Payment[]>;
  payment(id: string): Promise<Payment | null>;
  createCase(businessId: string, customerId: string): Promise<SupportCase>;
  getCase(id: string): Promise<SupportCase | null>;
  listCases(status?: CaseStatus): Promise<SupportCase[]>;
  updateCase(id: string, patch: CasePatch): Promise<SupportCase>;
  resolveCase(id: string, actor: string, expectedVersion?: number): Promise<SupportCase>;
  setOwnership(id: string, ownership: 'bot' | 'staff', actor: string, expectedVersion?: number): Promise<SupportCase>;
  staffMessage(id: string, body: string, expectedVersion?: number): Promise<Message>;
  acquireTurn(caseId: string, runId: string): Promise<TurnLease | null>;
  assertTurn(lease: TurnLease): Promise<boolean>;
  releaseTurn(lease: TurnLease): Promise<void>;
  enqueueTurn(caseId: string, customerId: string, body: string, clientMessageId?: string): Promise<AcceptedTurn>;
  pendingTurnJobs(limit?: number,businessId?:string): Promise<SupportTurnJob[]>;
  activeTurnJob(caseId: string): Promise<SupportTurnJob | null>;
  claimTurnJob(id: string, workerId: string,businessId?:string): Promise<{job:SupportTurnJob;lease:TurnLease}|null>;
  heartbeatTurnJob(lease: TurnLease): Promise<boolean>;
  failTurnJob(lease: TurnLease, error: string, retry: boolean): Promise<void>;
  completeTurn(lease: TurnLease, patch: CasePatch, body: string, sourceRefs?: Message['sourceRefs'], context?: TurnContext): Promise<{ case: SupportCase; reply: Message } | null>;
  addMessage(caseId: string, role: MessageRole, body: string): Promise<Message>;
  messages(caseId: string): Promise<Message[]>;
  createProposal(proposal: NewProposal, lease?: TurnLease, requestTargets?: RequestTarget[]): Promise<Proposal>;
  proposal(id: string): Promise<Proposal | null>;
  proposals(caseId: string): Promise<Proposal[]>;
  /** Exact-args approval is a decision only. It performs no business action. */
  decideProposal(id: string, argsHash: string, decision: 'approved' | 'rejected', actor: string): Promise<Proposal | null>;
  /** Atomically reserve the proposal AND payment before any external write. */
  claimExecution(id: string, argsHash: string, actor: string): Promise<Proposal | null>;
  /** Compatibility for automatic, low-risk handoff. Never bypasses refund approval. */
  claimProposal(id: string, argsHash: string, to: 'executing' | 'rejected', actor: string): Promise<Proposal | null>;
  finishProposal(id: string, status: 'executed' | 'failed' | 'unknown', result: Record<string, unknown> | null, error: string | null): Promise<Proposal>;
  recordRefund(refund: Omit<Refund, 'id' | 'createdAt' | 'simulated'>): Promise<Refund>;
  refunds(customerId?: string): Promise<Refund[]>;
  audit(caseId: string, type: string, actor: string, data?: Record<string, unknown>): Promise<AuditEvent>;
  auditEvents(caseId: string): Promise<AuditEvent[]>;
  recordRun(run: Omit<AgentRun, 'id' | 'createdAt'>, id?:string): Promise<AgentRun>;
  runs(caseId?: string): Promise<AgentRun[]>;
  metrics(businessId?:string): Promise<Metrics>;
  knowledge(businessId: string): Promise<KnowledgeSource[]>;
  saveKnowledge(source: KnowledgeSource, expectedVersion?: number): Promise<KnowledgeSource>;
  /** Every saved version of one source, newest first. */
  knowledgeVersions(businessId: string, id: string): Promise<KnowledgeSource[]>;
  skills(businessId: string): Promise<SupportSkill[]>;
  saveSkill(skill: SupportSkill, expectedRevision?:number): Promise<SupportSkill>;
  settings(businessId: string): Promise<SupportSettings>;
  classificationState(businessId: string): Promise<ClassificationState>;
  saveSettings(settings: SupportSettings, expectedVersion: number): Promise<SupportSettings>;
}
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
export class MemorySupportStore implements SupportStore {
  private requestHistory = new Map<string, RequestEvent[]>();
  private requestCatalogs = new Map<string, RequestCatalog>();
  private requestCheckpoints = new Map<string, {fingerprint:string}>();
  businesses = new Map<string, Business>();
  customers = new Map<string, Customer>();
  paymentRows = new Map<string, Payment>();
  cases = new Map<string, SupportCase>();
  messageRows: Message[] = [];
  proposalRows = new Map<string, Proposal>();
  refundRows: Refund[] = [];
  auditRows: AuditEvent[] = [];
  runRows: AgentRun[] = [];
  private turns = new Map<string, TurnLease & { startedAt: number }>();
  private executionPayments = new Map<string, string>();
  private knowledgeRows = new Map<string, KnowledgeSource>();
  private knowledgeHistory: KnowledgeSource[] = [];
  private skillRows = new Map<string, SupportSkill>();
  private settingRows = new Map<string, StoredSettings>();
  private turnJobs = new Map<string, SupportTurnJob>();
  private clientMessages = new Map<string, string>();
  readonly integrationStore = new MemoryIntegrationStore((businessId, integrationId, reason) => {
    for (const row of this.proposalRows.values()) if (row.tool === 'external_action' && this.cases.get(row.caseId)?.businessId === businessId && row.args.integrationId === integrationId && ['pending', 'approved'].includes(row.status)) {
      Object.assign(row, { status: 'invalidated', error: reason });
      this.terminalExternal(row,'action.invalidated',reason,`Запит «${String(row.args.title)}» відкликано через зміну налаштувань інтеграції. Його не виконано; звернення передано спеціалісту.`);
    }
  },(businessId,integrationId)=>[...this.externalExecutions.entries()].some(([id,execution])=>['admitted','dispatched','unknown'].includes(execution.status)&&this.cases.get(this.proposalRows.get(id)?.caseId??'')?.businessId===businessId&&this.proposalRows.get(id)?.args.integrationId===integrationId));
  private externalExecutions = new Map<string, { status: 'admitted' | 'dispatched' | 'executed' | 'failed' | 'unknown'; messageId?: string }>();
  constructor(seed?: SeedData) { if (seed) void this.reset(seed); }
  async reset(seed: SeedData) {
    this.businesses = new Map(seed.businesses.map(b => [b.id, copy(b)]));
    this.customers = new Map(seed.customers.map(c => [c.id, copy(c)]));
    this.paymentRows = new Map(seed.payments.map(p => [p.id, copy(p)]));
    this.requestCatalogs.clear(); this.requestCheckpoints.clear(); this.requestHistory.clear();
    this.cases.clear(); this.messageRows = []; this.proposalRows.clear();
    this.refundRows = []; this.auditRows = []; this.runRows = [];
    this.turns.clear(); this.executionPayments.clear(); this.knowledgeRows.clear(); this.knowledgeHistory = []; this.skillRows.clear(); this.settingRows.clear();
    this.turnJobs.clear(); this.clientMessages.clear();
    this.integrationStore.clear(); this.externalExecutions.clear();
  }
  private requestView(caseId:string) { const catalog=this.requestCatalogs.get(caseId)??emptyCatalog(); const events=this.requestHistory.get(caseId)??[];
    const unrepresented=hasUnrepresentedInput(catalog.requests,this.messageRows.filter(message=>message.caseId===caseId&&message.role==='customer'));
    return publicCatalog({...catalog,...(unrepresented?{syncState:'needs_review' as const}:{}),history:{events:events.slice(-100),hasMore:events.length>100}}); }
  async requestCatalog(caseId:string) { return this.requestView(caseId); }
  private saveRequests(caseId:string,catalog:RequestCatalog) {
    this.requestHistory.set(caseId,[...(this.requestHistory.get(caseId)??[]),...catalog.history.events]);
    this.requestCatalogs.set(caseId,{...catalog,history:{events:[],hasMore:false}});
    const supportCase=this.cases.get(caseId);if(supportCase) supportCase.status=this.caseStatus(caseId,supportCase.status);
  }
  private invalidateRequestActions(ids: string[]) {
    for (const id of ids) { const proposal = this.proposalRows.get(id); if (proposal && ['pending','approved'].includes(proposal.status)) {
      proposal.status = 'invalidated'; proposal.error = 'Request goal changed';
      this.auditRows.push({id:randomUUID(),caseId:proposal.caseId,type:'action.invalidated',actor:'system:requests',data:{proposalId:id,reason:'request_revision_changed'},createdAt:now()});
    } }
  }
  async requestCheckpoint(lease: TurnLease, sourceMessageId: string, batch: RequestCheckpoint) {
    if (!this.activeTurn(lease)) throw new StaleTurn('Conversation ownership changed');
    batch=requestCheckpointSchema.parse(batch);
    if(lease.jobFence!==undefined&&this.turnJobs.get(lease.runId)?.customerMessageId!==sourceMessageId) throw new StaleTurn('Customer message does not match the leased job');
    const fingerprint = createHash('sha256').update(JSON.stringify(batch)).digest('hex'); const key=lease.caseId+':'+sourceMessageId;
    const old=this.requestCheckpoints.get(key);
    if(old) { if(old.fingerprint!==fingerprint) throw new VersionConflict('Message already has a different request checkpoint'); return this.requestView(lease.caseId); }
    const changed=applyCheckpoint(this.requestCatalogs.get(lease.caseId)??emptyCatalog(),batch,sourceMessageId,this.messageRows.filter(message=>message.caseId===lease.caseId),'agent:'+lease.runId);
    this.invalidateRequestActions(changed.invalidated); this.saveRequests(lease.caseId,changed.catalog);
    const response=this.requestView(lease.caseId); this.requestCheckpoints.set(key,{fingerprint}); return response;
  }
  async requestTransition(caseId:string,requestId:string,change:RequestTransition,actor:string) {
    if(!this.cases.has(caseId)) throw new VersionConflict('Conversation not found');
    const changed=transitionRequest({...this.requestView(caseId),history:{events:[],hasMore:false}},requestId,change,this.messageRows.filter(message=>message.caseId===caseId),[...this.proposalRows.values()].filter(proposal=>proposal.caseId===caseId),actor);
    this.invalidateRequestActions(changed.invalidated); this.saveRequests(caseId,changed.catalog); this.cases.get(caseId)!.status=this.caseStatus(caseId,'resolved'); return this.requestView(caseId);
  }
  private requestActionAllowed(row:Proposal) {
    const catalog=this.requestCatalogs.get(row.caseId)??emptyCatalog();
    const linked=catalog.requests.filter(request=>request.actions.some(link=>link.proposalId===row.id));
    const unresolved=linked.some(request=>request.actions.some(link=>link.proposalId!==row.id&&['executing','unknown'].includes(this.proposalRows.get(link.proposalId)?.status??'')));
    return (row.tool==='escalate_to_human'||!unresolved)&&actionAllowed(catalog,row.id,row.tool==='escalate_to_human');
  }
  async seedIfEmpty(seed: SeedData) { if (!this.businesses.size) await this.reset(seed); }
  async recoverInterruptedExecutions(businessId?:string) {
    await this.expireExternalActions(undefined,businessId);
    for(const proposal of this.proposalRows.values()) if((!businessId||this.cases.get(proposal.caseId)?.businessId===businessId)&&proposal.status==='executing' && proposal.decidedAt && Date.now()-Date.parse(proposal.decidedAt)>180000) {
      const external=this.externalExecutions.get(proposal.id);
      if(external) { await this.finishExternalAction(proposal.id,external.status==='admitted'?'failed':'unknown',null,external.status==='admitted'?'interrupted_before_dispatch':'interrupted_after_dispatch','Результат зовнішньої дії потребує перевірки спеціалістом. Автоматичний повтор заблоковано.','system:recovery');continue; }
      Object.assign(proposal,{status:'unknown',error:'Execution confirmation was interrupted; manual reconciliation required'});
      const execution = this.externalExecutions.get(proposal.id); if (execution) execution.status = 'unknown';
      await this.audit(proposal.caseId,'action.unknown','system:recovery',{proposalId:proposal.id});
    }
  }
  async businessesList() { return copy([...this.businesses.values()]); }
  async createBusiness(business: Business) {
    if([...this.businesses.values()].some(row=>row.slug===business.slug)) throw new VersionConflict('Business slug already exists');
    this.businesses.set(business.id,copy(business));return copy(business);
  }
  async createCustomer(customer: Customer) { this.customers.set(customer.id,copy(customer));return copy(customer); }
  async customerBySession(token: string) { return copy([...this.customers.values()].find(c => c.sessionToken === token) ?? null); }
  async customer(id: string) { return copy(this.customers.get(id) ?? null); }
  async business(id: string) { return copy(this.businesses.get(id) ?? null); }
  async payments(customerId: string, limit = 10) {
    return copy([...this.paymentRows.values()].filter(p => p.customerId === customerId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,limit));
  }
  async payment(id: string) { return copy(this.paymentRows.get(id) ?? null); }
  async createCase(businessId: string, customerId: string) {
    const row: SupportCase = { id: randomUUID(), businessId, customerId, customerName: this.customers.get(customerId)?.name ?? '', status:'open', priority:'P3', intent:null, analysis:null, ownership:'bot', ownershipVersion:0, assignedTo:null, createdAt:now(), updatedAt:now() };
    this.cases.set(row.id,row); return copy(row);
  }
  async getCase(id: string) { return copy(this.cases.get(id) ?? null); }
  async listCases(status?: CaseStatus) { return copy([...this.cases.values()].filter(c => !status || c.status === status).sort((a,b) => a.priority.localeCompare(b.priority) || b.updatedAt.localeCompare(a.updatedAt))); }
  async updateCase(id: string, patch: CasePatch) {
    const row = this.cases.get(id); if (!row) throw new Error('Case not found');
    Object.assign(row,copy(patch),{updatedAt:now()}); row.status=this.caseStatus(id,row.status,row.ownership); return copy(row);
  }
  async setOwnership(id: string, ownership: 'bot'|'staff', actor: string, expectedVersion?: number) { return this.ownCase(id,ownership,actor,expectedVersion); }
  private ownCase(id:string,ownership:'bot'|'staff',actor:string,expectedVersion?:number) {
    const row = this.cases.get(id); if (!row) throw new Error('Case not found');
    if (expectedVersion !== undefined && row.ownershipVersion !== expectedVersion) throw new VersionConflict('Conversation ownership changed');
    row.ownership=ownership; row.ownershipVersion++; row.assignedTo=ownership==='staff'?actor:null; row.updatedAt=now();
    this.turns.delete(id);
    for(const job of this.turnJobs.values()) if(job.caseId===id && ['queued','running'].includes(job.status)) Object.assign(job,{status:'cancelled',workerId:null,leaseExpiresAt:null,updatedAt:now()});
    // A handoff revokes decisions prepared under the previous ownership.
    for (const proposal of this.proposalRows.values()) if (proposal.caseId===id && ['pending','approved'].includes(proposal.status)) Object.assign(proposal,{status:'rejected',error:'Conversation ownership changed'});
    return copy(row);
  }
  private caseStatus(id:string,status:CaseStatus,ownership=this.cases.get(id)!.ownership) { return aggregateRequestStatus(this.requestView(id),status,ownership,[...this.proposalRows.values()].filter(proposal=>proposal.caseId===id)); }
  async resolveCase(id:string,actor:string,expectedVersion?:number) {
    if(!this.cases.has(id)) throw new VersionConflict('Conversation not found');
    if(this.caseStatus(id,'resolved')!=='resolved') throw new VersionConflict('Complete or cancel the tracked requests and reconcile pending actions before resolving this conversation');
    const row=this.ownCase(id,'staff',actor,expectedVersion);this.cases.get(id)!.status='resolved';return {...row,status:'resolved' as const};
  }
  async staffMessage(id: string, body: string, expectedVersion?: number) {
    const row=this.cases.get(id);
    if (!row || row.ownership!=='staff' || (expectedVersion!==undefined && row.ownershipVersion!==expectedVersion)) throw new VersionConflict('Take over the current conversation before replying');
    return this.addMessage(id,'operator',body);
  }
  private activeTurn(lease: TurnLease) {
    const row=this.cases.get(lease.caseId); const active=this.turns.get(lease.caseId);
    const job=lease.jobFence===undefined?null:this.turnJobs.get(lease.runId);
    return Boolean(row?.ownership==='bot' && row.ownershipVersion===lease.ownershipVersion && active?.runId===lease.runId && Date.now()-active.startedAt<180000 && (lease.jobFence===undefined || (job?.status==='running' && job.fence===lease.jobFence && job.workerId===lease.workerId && Date.parse(job.leaseExpiresAt??'')>Date.now())));
  }
  async acquireTurn(caseId: string, runId: string) {
    const row=this.cases.get(caseId);
    const old=this.turns.get(caseId);
    if (!row || row.ownership!=='bot' || [...this.turnJobs.values()].some(job=>job.caseId===caseId && ['queued','running'].includes(job.status)) || (old && Date.now()-old.startedAt<180000)) return null;
    if (old) {
      row.ownershipVersion++;
      for (const proposal of this.proposalRows.values()) if (proposal.caseId===caseId && ['pending','approved'].includes(proposal.status)) Object.assign(proposal,{status:'rejected',error:'Previous run expired'});
    }
    const lease={caseId,runId,ownershipVersion:row.ownershipVersion}; this.turns.set(caseId,{...lease,startedAt:Date.now()}); return copy(lease);
  }
  async assertTurn(lease: TurnLease) {
    return this.activeTurn(lease);
  }
  async releaseTurn(lease: TurnLease) { if (this.turns.get(lease.caseId)?.runId===lease.runId && (lease.jobFence===undefined || this.turnJobs.get(lease.runId)?.fence===lease.jobFence)) this.turns.delete(lease.caseId); }
  async enqueueTurn(caseId: string, customerId: string, body: string, clientMessageId?: string): Promise<AcceptedTurn> {
    const supportCase = this.cases.get(caseId);
    if (!supportCase || supportCase.customerId !== customerId) throw new VersionConflict('Conversation not found');
    const key = clientMessageId ? caseId + ':' + clientMessageId : null;
    const previousId = key ? this.clientMessages.get(key) : undefined;
    const previous = previousId ? this.messageRows.find(message => message.id === previousId) : undefined;
    if (previous) {
      if (previous.body !== body) throw new VersionConflict('Message id already identifies different content');
      return { case: copy(supportCase), message: copy(previous), job: copy([...this.turnJobs.values()].find(job => job.customerMessageId === previous.id) ?? null) };
    }
    const active = [...this.turnJobs.values()].find(job => job.caseId === caseId && ['queued', 'running'].includes(job.status));
    if (active) {
      if (active.body !== body) throw new VersionConflict('A support run is already queued for this conversation');
      return { case: copy(supportCase), message: copy(this.messageRows.find(message => message.id === active.customerMessageId)!), job: copy(active) };
    }
    if (this.turns.has(caseId)) throw new VersionConflict('A support run is active');
    const message: Message = { id: randomUUID(), caseId, role: 'customer', body, createdAt: now() };
    this.messageRows.push(message);
    if (key) this.clientMessages.set(key, message.id);
    supportCase.updatedAt = now();
    this.reopenForInput(caseId,body);
    if (supportCase.ownership === 'staff') return { case: copy(supportCase), message: copy(message), job: null };
    const job: SupportTurnJob = { id: randomUUID(), caseId, customerId, customerMessageId: message.id, body,
      ownershipVersion: supportCase.ownershipVersion, status: 'queued', attempts: 0, fence: 0, workerId: null,
      leaseExpiresAt: null, availableAt: now(), error: null, createdAt: now(), updatedAt: now() };
    this.turnJobs.set(job.id, job);
    return { case: copy(supportCase), message: copy(message), job: copy(job) };
  }
  async pendingTurnJobs(limit=50,businessId?:string) {
    return copy([...this.turnJobs.values()].filter(job=>(!businessId||this.cases.get(job.caseId)?.businessId===businessId)&&((job.status==='queued'&&Date.parse(job.availableAt)<=Date.now())||(job.status==='running'&&Date.parse(job.leaseExpiresAt??'')<=Date.now()))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(0,limit));
  }
  async activeTurnJob(caseId: string) { return copy([...this.turnJobs.values()].find(job => job.caseId === caseId && ['queued','running'].includes(job.status)) ?? null); }
  async claimTurnJob(id: string, workerId: string,businessId?:string) {
    const job = this.turnJobs.get(id);
    if(job&&businessId&&this.cases.get(job.caseId)?.businessId!==businessId)return null;
    const supportCase = job ? this.cases.get(job.caseId) : undefined;
    if (!job || !supportCase || !['queued','running'].includes(job.status) || Date.parse(job.availableAt) > Date.now() || (job.status === 'running' && Date.parse(job.leaseExpiresAt ?? '') > Date.now())) return null;
    if (supportCase.ownership !== 'bot' || supportCase.ownershipVersion !== job.ownershipVersion) { job.status = 'cancelled'; return null; }
    if (job.attempts >= 3) {
      Object.assign(job, { status: 'failed', workerId: null, leaseExpiresAt: null, error: 'Worker recovery limit reached', updatedAt: now() });
      if(this.turns.get(job.caseId)?.runId===id) this.turns.delete(job.caseId);
      this.messageRows.push({ id: randomUUID(), caseId: job.caseId, role: 'system', body: 'Не вдалося завершити відповідь після відновлення. Зверніться до оператора.', createdAt: now() });
      await this.audit(job.caseId,'run.failed','worker:recovery',{runId:id,attempts:job.attempts});
      return null;
    }
    const active = this.turns.get(job.caseId);
    if (active && active.runId !== job.id) return null;
    Object.assign(job, { status: 'running', attempts: job.attempts + 1, fence: job.fence + 1, workerId, leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), updatedAt: now() });
    const lease: TurnLease = { caseId: job.caseId, runId: job.id, ownershipVersion: job.ownershipVersion, jobFence: job.fence, workerId };
    this.turns.set(job.caseId, { ...lease, startedAt: Date.now() });
    return { job: copy(job), lease };
  }
  async heartbeatTurnJob(lease: TurnLease) {
    if (!this.activeTurn(lease)) return false;
    const job = this.turnJobs.get(lease.runId)!;
    job.leaseExpiresAt = new Date(Date.now() + 30000).toISOString();
    this.turns.get(lease.caseId)!.startedAt = Date.now();
    return true;
  }
  async failTurnJob(lease: TurnLease, error: string, retry: boolean) {
    const job = this.turnJobs.get(lease.runId);
    if (!job || job.status !== 'running' || job.fence !== lease.jobFence || job.workerId !== lease.workerId) return;
    const supportCase = this.cases.get(lease.caseId)!;
    const owned = supportCase.ownership === 'bot' && supportCase.ownershipVersion === lease.ownershipVersion;
    const status = !owned ? 'cancelled' : retry && job.attempts < 3 ? 'queued' : 'failed';
    Object.assign(job, { status, error: error.slice(0,300), workerId: null, leaseExpiresAt: null, availableAt: new Date(Date.now() + 1000).toISOString(), updatedAt: now() });
    await this.releaseTurn(lease);
    if (status === 'failed') await this.addMessage(lease.caseId, 'system', 'Не вдалося завершити відповідь. Зверніться до оператора або надішліть повідомлення ще раз.');
    await this.audit(lease.caseId, 'run.' + status, 'worker', { runId: job.id, attempts: job.attempts });
  }
  async completeTurn(lease: TurnLease, patch: CasePatch, body: string, sourceRefs: Message['sourceRefs'] = [], context?: TurnContext) {
    if (!this.activeTurn(lease)) return null;
    if(context?.integrationRefs?.some(ref=>{const state=this.integrationStore.peek(this.cases.get(lease.caseId)!.businessId,ref.integrationId);return !state||!state.enabled||state.draining||state.activeManifestHash!==ref.manifestHash||state.connectionRevision!==ref.connectionRevision||state.policy.policyRevision!==ref.policyRevision;})) return null;
    if (sourceRefs.some(ref=>{ const source=this.knowledgeRows.get(ref.id); return !source || source.version!==ref.version || source.status!=='published' || source.businessId!==this.cases.get(lease.caseId)?.businessId; })) return null;
    if(context && (JSON.stringify(this.businesses.get(this.cases.get(lease.caseId)!.businessId)?.policy)!==JSON.stringify(context.policy) || context.skills.some(ref=>{const skill=this.skillRows.get(ref.id);return !skill || !skill.enabled || skill.revision!==ref.revision;}))) return null;
    if(context?.settingsVersion!==undefined&&(this.settingRows.get(this.cases.get(lease.caseId)!.businessId)?.version??1)!==context.settingsVersion)return null;
    if(context&&JSON.stringify([...this.skillRows.values()].filter(row=>row.businessId===this.cases.get(lease.caseId)!.businessId&&row.enabled).map(row=>[row.id,row.revision]).sort())!==JSON.stringify(context.skills.map(row=>[row.id,row.revision]).sort()))return null;
    if (context && !sameClassificationConfig(visibleClassification(this.settingRows.get(this.cases.get(lease.caseId)!.businessId)?.classification), context.classification)) return null;
    const row=this.cases.get(lease.caseId)!;
    Object.assign(row,copy(patch),{updatedAt:now()}); row.status=this.caseStatus(lease.caseId,row.status,row.ownership);
    if (patch.ownership==='staff') {
      row.ownershipVersion++; row.assignedTo='queue:tier-2';
      for(const proposal of this.proposalRows.values()) if(proposal.caseId===lease.caseId && ['pending','approved'].includes(proposal.status)) Object.assign(proposal,{status:'rejected',error:'Conversation handed to staff'});
    }
    const completionId=context?.completionActionId?this.externalExecutions.get(context.completionActionId)?.messageId:undefined;
    const existingMessage=completionId?this.messageRows.find(message=>message.id===completionId&&message.caseId===lease.caseId):undefined;
    const message: Message=existingMessage??{id:randomUUID(),caseId:lease.caseId,role:'assistant',body,createdAt:now(),sourceRefs:copy(sourceRefs),externalSourceRefs:copy(context?.externalSourceRefs ?? [])};
    if(!existingMessage) this.messageRows.push(message); const reply=copy(message);
    if (lease.jobFence !== undefined) {
      Object.assign(this.turnJobs.get(lease.runId)!, { status: 'completed', workerId: null, leaseExpiresAt: null, updatedAt: now() });
      this.turns.delete(lease.caseId);
    }
    return {case:copy(row),reply};
  }
  private reopenForInput(caseId:string,body:string) {
    const row=this.cases.get(caseId);if(row?.status==='resolved'&&this.requestCatalogs.get(caseId)?.requests.length&&!isAcknowledgement(body)) {row.status=row.ownership==='staff'?'escalated':'open';row.updatedAt=now();}
  }
  async addMessage(caseId: string, role: MessageRole, body: string) {
    const row:Message={id:randomUUID(),caseId,role,body,createdAt:now()}; this.messageRows.push(row);if(role==='customer')this.reopenForInput(caseId,body);return copy(row);
  }
  async messages(caseId: string) { return copy(this.messageRows.filter(m=>m.caseId===caseId)); }
  async createProposal(proposal: NewProposal, lease?: TurnLease, requestTargets?: RequestTarget[]) {
    if (lease && (lease.caseId !== proposal.caseId || !this.activeTurn(lease))) throw new StaleTurn('Conversation ownership changed');
    if (lease && proposal.tool !== 'escalate_to_human' && (!requestTargets?.length || requestTargets.some(target=>!this.requestCatalogs.get(proposal.caseId)?.requests.some(row=>row.id===target.id&&row.sourceMessageIds.includes(this.requestCatalogs.get(proposal.caseId)!.lastSourceMessageId??''))))) throw new VersionConflict('Select the customer requests for this action');
    if(lease?.jobFence!==undefined) {
      const previous=[...this.proposalRows.values()].find(row=>row.turnJobId===lease.runId && row.tool===proposal.tool);
      if(previous) { if(previous.argsHash!==proposal.argsHash) throw new StaleTurn('Recovered action arguments changed; staff review required');return copy(previous); }
    }
    const row:Proposal={...copy(proposal),turnJobId:lease?.jobFence!==undefined?lease.runId:null,id:randomUUID(),decidedBy:null,decidedAt:null,result:null,error:null,createdAt:now()};
    if (requestTargets?.length) {
      const catalog=linkAction(this.requestCatalogs.get(row.caseId)??emptyCatalog(),requestTargets,row.id,'agent:'+(lease?.runId??'unknown'),row.tool==='escalate_to_human');
      this.saveRequests(row.caseId,catalog);
    }
    this.proposalRows.set(row.id,row); return copy(row);
  }
  async proposal(id: string) { return copy(this.proposalRows.get(id) ?? null); }
  async proposals(caseId: string) { return copy([...this.proposalRows.values()].filter(p=>p.caseId===caseId)); }
  private guardAdmission(row:Proposal,automatic=false) {
    const business=this.businesses.get(this.cases.get(row.caseId)?.businessId??'');if(!business)return false;
    const result=evaluateGuards(row.tool,row.args,business.policy.guards,business.currency);
    if(result.checks.length||!result.allowed)this.auditRows.push({id:randomUUID(),caseId:row.caseId,type:'guard.evaluated',actor:'system:guards',data:{proposalId:row.id,guardRevision:business.policy.guardRevision??0,guards:result.rules,settingsVersion:this.settingRows.get(business.id)?.version??1,checks:result.checks,allowed:result.allowed&&(!automatic||!result.requiresApproval),requiresApproval:result.requiresApproval},createdAt:now()});
    return result.allowed&&(!automatic||!result.requiresApproval);
  }
  async decideProposal(id: string, argsHash: string, decision:'approved'|'rejected', actor:string) {
    const row=this.proposalRows.get(id);
    if (!row || row.status!=='pending' || row.argsHash!==argsHash) return null;
    if (decision === 'approved' && (!this.requestActionAllowed(row)||!this.guardAdmission(row))) return null;
    if (row.tool === 'external_action' && decision === 'approved' && !this.admitExternal(row, false)) return null;
    Object.assign(row,{status:decision,decidedBy:actor,decidedAt:now()}); return copy(row);
  }
  async claimExecution(id:string,argsHash:string,actor:string) {
    const row=this.proposalRows.get(id);
    if (!row || row.argsHash!==argsHash || row.status!=='approved' || !row.decidedAt || Date.now()-Date.parse(row.decidedAt)>15*60*1000) return null;
    if (!this.requestActionAllowed(row)||!this.guardAdmission(row)) return null;
    if (row.tool === 'external_action' && !this.admitExternal(row, true,actor)) return null;
    if (row.tool==='refund_payment') {
      const paymentId=String(row.args.payment_id);
      if (this.executionPayments.has(paymentId)) return null;
      this.executionPayments.set(paymentId,row.id);
    }
    row.status='executing'; row.decidedBy=actor; row.decidedAt=now(); if(row.tool==='external_action') row.authorizationOrigin='operator_approval'; return copy(row);
  }
  async claimProposal(id:string,argsHash:string,to:'executing'|'rejected',actor:string) {
    if (to==='rejected') return this.decideProposal(id,argsHash,'rejected',actor);
    const row=this.proposalRows.get(id);
    if (!row || !AUTO_CLAIMABLE.includes(row.tool) || row.policy.requiresApproval!==false || row.status!=='pending' || row.argsHash!==argsHash) return null;
    if (!this.requestActionAllowed(row)||!this.guardAdmission(row,true)) return null;
    if (row.tool === 'external_action' && !this.admitExternal(row, true,actor)) return null;
    if(row.tool==='external_action') row.authorizationOrigin='policy_auto';
    Object.assign(row,{status:to,decidedBy:actor,decidedAt:now()}); return copy(row);
  }
  private admitExternal(row: Proposal, claim: boolean,actor='system') {
    const supportCase = this.cases.get(row.caseId);
    const unresolved=[...this.externalExecutions.entries()].some(([id,execution])=>id!==row.id&&execution.status==='unknown'&&this.proposalRows.get(id)?.caseId===row.caseId);
    const reason = unresolved?'unknown_execution_pending':supportCase ? externalAdmissionReason(row, supportCase, this.integrationStore.peek(supportCase.businessId, String(row.args.integrationId))) : 'case_removed';
    if (reason) { Object.assign(row, { status: reason === 'approval_expired' ? 'expired' : 'invalidated', error: reason });this.terminalExternal(row,reason==='approval_expired'?'action.expired':'action.invalidated',reason,reason==='approval_expired'?`Строк погодження дії «${String(row.args.title)}» минув. Дію не виконано; звернення передано спеціалісту.`:`Дію «${String(row.args.title)}» не виконано: дозвіл змінився або попередній результат потребує перевірки спеціалістом.`);return false; }
    if (claim) { if (this.externalExecutions.has(row.id)) return false; this.externalExecutions.set(row.id, { status: 'admitted' });this.auditRows.push({id:randomUUID(),caseId:row.caseId,type:'action.claimed',actor,data:{proposalId:row.id,integrationId:row.args.integrationId,operationKey:row.args.operationKey,manifestHash:row.args.manifestHash,connectionRevision:row.args.connectionRevision,policyRevision:row.args.policyRevision,argsHash:row.argsHash,origin:actor==='agent:auto'?'policy_auto':'operator_approval'},createdAt:now()}); }
    return true;
  }
  async markExternalDispatched(id: string) {
    const execution = this.externalExecutions.get(id);
    const proposal=this.proposalRows.get(id);
    if (!execution || execution.status !== 'admitted'||proposal?.status!=='executing'||!this.guardAdmission(proposal,proposal.authorizationOrigin==='policy_auto')) return false;
    execution.status = 'dispatched';this.auditRows.push({id:randomUUID(),caseId:proposal.caseId,type:'action.dispatched',actor:proposal.decidedBy??'system',data:{proposalId:id,integrationId:proposal.args.integrationId,operationKey:proposal.args.operationKey,manifestHash:proposal.args.manifestHash,connectionRevision:proposal.args.connectionRevision,policyRevision:proposal.args.policyRevision,argsHash:proposal.argsHash,origin:proposal.authorizationOrigin},createdAt:now()});return true;
  }
  async expireExternalActions(caseId?: string,businessId?:string) {
    for (const row of this.proposalRows.values()) if((caseId===undefined||row.caseId===caseId)&&(!businessId||this.cases.get(row.caseId)?.businessId===businessId)&&row.tool==='external_action' && ['pending','approved'].includes(row.status) && typeof row.args.expiresAt==='string' && Date.parse(row.args.expiresAt)<=Date.now()) {
      Object.assign(row,{status:'expired',error:'approval_expired'});this.terminalExternal(row,'action.expired','approval_expired',`Строк погодження дії «${String(row.args.title)}» минув. Дію не виконано; звернення передано спеціалісту.`);
    }
  }
  private terminalExternal(row:Proposal,event:string,reason:string,message:string) {
    const supportCase=this.cases.get(row.caseId);if(!supportCase) return;
    Object.assign(supportCase,{status:'escalated',ownership:'staff',ownershipVersion:supportCase.ownershipVersion+1,assignedTo:'queue:tier-2',updatedAt:now()});
    this.turns.delete(row.caseId);
    for(const job of this.turnJobs.values()) if(job.caseId===row.caseId&&['queued','running'].includes(job.status)) Object.assign(job,{status:'cancelled',workerId:null,leaseExpiresAt:null,updatedAt:now()});
    for(const other of this.proposalRows.values()) if(other.caseId===row.caseId&&['pending','approved'].includes(other.status)) Object.assign(other,{status:other.tool==='external_action'?'invalidated':'rejected',error:'Conversation handed to staff'});
    this.messageRows.push({id:randomUUID(),caseId:row.caseId,role:'assistant',body:message,createdAt:now()});
    this.auditRows.push({id:randomUUID(),caseId:row.caseId,type:event,actor:'system:integration',data:{proposalId:row.id,integrationId:row.args.integrationId,reasonCode:reason},createdAt:now()});
  }
  async finishExternalAction(id: string, status: 'executed' | 'failed' | 'unknown', result: Record<string, unknown> | null, error: string | null, message: string | null, actor: string, reconciliation = false) {
    const row = this.proposalRows.get(id); const execution = this.externalExecutions.get(id);
    if (!row || !execution) throw new Error('External execution not found');
    if(reconciliation&&row.status!=='unknown') throw new VersionConflict('Execution was already reconciled');
    if (!reconciliation&&row.status!=='executing') return copy(row);
    Object.assign(row, { status, result: copy(result), error }); execution.status = status;
    if (message && (!execution.messageId || reconciliation)) {
      const reply: Message = { id: randomUUID(), caseId: row.caseId, role: 'assistant', body: message, createdAt: now() };
      this.messageRows.push(reply); execution.messageId = reply.id;
    }
    const supportCase = this.cases.get(row.caseId)!;
    Object.assign(supportCase, { status: status === 'executed' ? supportCase.ownership==='staff'?supportCase.status:'resolved' : 'escalated', updatedAt: now() });
    supportCase.status=this.caseStatus(row.caseId,supportCase.status,supportCase.ownership);
    if (message && (status==='unknown'||(status!=='executed'&&actor!=='agent:auto'))) { supportCase.ownership='staff';supportCase.ownershipVersion++;supportCase.assignedTo=actor;this.turns.delete(row.caseId); }
    this.auditRows.push({id:randomUUID(),caseId:row.caseId,type:reconciliation?'action.reconciled':`action.${status}`,actor,data:{proposalId:id,operationKey:row.args.operationKey,origin:row.authorizationOrigin,reasonCode:error,guard:result?.guard??row.args.guard??null},createdAt:now()});
    return copy(row);
  }
  async finishProposal(id:string,status:'executed'|'failed'|'unknown',result:Record<string,unknown>|null,error:string|null) {
    const row=this.proposalRows.get(id); if (!row) throw new Error('Proposal not found');
    Object.assign(row,{status,result:copy(result),error}); return copy(row);
  }
  async recordRefund(refund:Omit<Refund,'id'|'createdAt'|'simulated'>) {
    if (this.refundRows.some(r=>r.paymentId===refund.paymentId || r.proposalId===refund.proposalId)) throw new DuplicateRefund('Payment already refunded');
    const row:Refund={...refund,id:randomUUID(),simulated:true,createdAt:now()};
    const payment=this.paymentRows.get(refund.paymentId); if (!payment) throw new Error('Payment not found');
    this.refundRows.push(row); payment.status='refunded'; return copy(row);
  }
  async refunds(customerId?:string) { return copy(this.refundRows.filter(r=>!customerId || this.paymentRows.get(r.paymentId)?.customerId===customerId)); }
  async audit(caseId:string,type:string,actor:string,data:Record<string,unknown>={}) {
    const row:AuditEvent={id:randomUUID(),caseId,type,actor,data:copy(data),createdAt:now()}; this.auditRows.push(row); return copy(row);
  }
  async auditEvents(caseId:string) { return copy(this.auditRows.filter(a=>a.caseId===caseId)); }
  async recordRun(run:Omit<AgentRun,'id'|'createdAt'>,id?:string) { const row={...copy(run),id:id??randomUUID(),createdAt:now()}; this.runRows.push(row); return copy(row); }
  async runs(caseId?:string) { return copy(this.runRows.filter(r=>!caseId || r.caseId===caseId)); }
  async metrics(businessId?:string):Promise<Metrics> {
    const cases=[...this.cases.values()].filter(row=>!businessId||row.businessId===businessId);const ids=new Set(cases.map(row=>row.id));
    const proposals=[...this.proposalRows.values()].filter(row=>ids.has(row.caseId));const refunds=this.refundRows.filter(row=>proposals.some(proposal=>proposal.id===row.proposalId));const runs=this.runRows.filter(row=>ids.has(row.caseId));
    const count=<K extends string>(keys:K[],values:K[])=>Object.fromEntries(keys.map(k=>[k,values.filter(v=>v===k).length])) as Record<K,number>;
    const timed=runs.filter(r=>r.status!=='failed');
    return { cases:cases.length,byStatus:count<CaseStatus>(['open','awaiting_approval','escalated','resolved'],cases.map(c=>c.status)),byPriority:count<Priority>(['P1','P2','P3'],cases.map(c=>c.priority)),
      proposals:count<ProposalStatus>(['pending','approved','executing','executed','rejected','failed','denied','unknown','expired','invalidated'],proposals.map(p=>p.status)),
      refundsIssuedCents:refunds.reduce((s,r)=>s+r.amountCents,0),agentRuns:runs.length,fallbackRuns:runs.filter(r=>r.status==='fallback').length,
      avgAgentLatencyMs:timed.length?Math.round(timed.reduce((s,r)=>s+r.latencyMs,0)/timed.length):null };
  }
  async knowledge(businessId:string) { return copy([...this.knowledgeRows.values()].filter(x=>x.businessId===businessId)); }
  async saveKnowledge(source:KnowledgeSource,expectedVersion?:number) {
    const old=this.knowledgeRows.get(source.id);
    if (expectedVersion!==undefined && (!old || old.version!==expectedVersion || old.businessId!==source.businessId)) throw new VersionConflict('Document version changed');
    const row:KnowledgeSource={...source,audience:source.audience??old?.audience??'customer',plans:source.plans??old?.plans??[],sourceUrl:source.sourceUrl??old?.sourceUrl??null};
    this.knowledgeRows.set(source.id,copy(row));
    if (!this.knowledgeHistory.some(h=>h.id===row.id&&h.version===row.version)) this.knowledgeHistory.push(copy(row));
    return copy(row);
  }
  async knowledgeVersions(businessId:string,id:string) { return copy(this.knowledgeHistory.filter(h=>h.businessId===businessId&&h.id===id).sort((a,b)=>b.version-a.version)); }
  async skills(businessId:string) { return copy([...this.skillRows.values()].filter(x=>x.businessId===businessId)); }
  async saveSkill(skill:SupportSkill,expectedRevision?:number) {
    if(!this.businesses.has(skill.businessId))throw new VersionConflict('Business not found');
    const old=this.skillRows.get(skill.id);
    if(old&&(old.businessId!==skill.businessId||old.revision!==(expectedRevision??skill.revision-1)||skill.revision<=old.revision)||!old&&expectedRevision!==undefined)throw new VersionConflict('Skill revision changed');
    this.skillRows.set(skill.id,copy(skill));return copy(skill);
  }
  async settings(businessId:string):Promise<SupportSettings> {
    const stored=this.settingRows.get(businessId); if (stored) return copy({ ...stored, ...databasePolicyUpdate(this.businesses.get(businessId)?.policy??{},{}), ...(this.businesses.get(businessId)?.policy.guards===undefined?{}:{guards:this.businesses.get(businessId)!.policy.guards,guardRevision:this.businesses.get(businessId)!.policy.guardRevision??0}), classification: visibleClassification(stored.classification) });
    const business=this.businesses.get(businessId); if (!business) throw new Error('Business not found');
    return {businessId,version:1,language:'uk',tone:'empathetic',requireApproval:true,...copy(business.policy)};
  }
  async classificationState(businessId:string) { return classificationState(this.settingRows.get(businessId)?.classification); }
  async saveSettings(settings:SupportSettings,expectedVersion:number) {
    const old = this.settingRows.get(settings.businessId);
    if ((old?.version ?? 1)!==expectedVersion) throw new VersionConflict('Settings version changed');
    if (!canReplaceClassification(old?.classification, settings.classification)) throw new VersionConflict('Classification changes require a newer revision');
    const business=this.businesses.get(settings.businessId);if(!business)throw new VersionConflict('Business not found');
    const guards=guardPolicyUpdate(business.policy,settings);if(!guards)throw new VersionConflict('Guard revision changed');
    const database = databasePolicyUpdate(business.policy, settings);
    settings={...settings,...guards,...database};
    const classification = storedClassification(old?.classification, settings.classification);
    this.settingRows.set(settings.businessId,copy({ ...settings, classification }));
    settings = { ...settings, classification: visibleClassification(classification) };
    business.policy={refundLimitCents:settings.refundLimitCents,duplicateWindowMinutes:settings.duplicateWindowMinutes,enabledTools:copy(settings.enabledTools),...guards,...database};
    return copy(settings);
  }
}
