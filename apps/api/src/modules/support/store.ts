import { randomUUID } from 'node:crypto';
import type { AcceptedTurn, AgentRun, AuditEvent, Business, CaseStatus, Customer, KnowledgeSource, Message, MessageRole, Metrics, Payment, Priority, Proposal, ProposalStatus, Refund, SupportCase, SupportSettings, SupportSkill, SupportTurnJob, TurnLease } from './contracts.js';
import type { SeedData } from './seed.js';
import { sameClassificationConfig } from '../agent/classification.js';
import { canReplaceClassification, classificationState, storedClassification, visibleClassification, type ClassificationState, type StoredClassification } from './classification-storage.js';
type StoredSettings = Omit<SupportSettings, 'classification'> & { classification?: StoredClassification };

export type NewProposal = Omit<Proposal, 'id' | 'createdAt' | 'decidedBy' | 'decidedAt' | 'result' | 'error'>;
export type CasePatch = Partial<Pick<SupportCase, 'status' | 'priority' | 'intent' | 'analysis' | 'ownership' | 'assignedTo'>>;
export interface TurnContext { policy: Business['policy']; skills: { id: string; revision: number }[]; classification?: SupportSettings['classification'] }
export class DuplicateRefund extends Error {}
export class StaleTurn extends Error {}
export class VersionConflict extends Error {}
export interface SupportStore {
  reset(seed: SeedData): Promise<void>;
  seedIfEmpty(seed: SeedData): Promise<void>;
  recoverInterruptedExecutions(): Promise<void>;
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
  setOwnership(id: string, ownership: 'bot' | 'staff', actor: string, expectedVersion?: number): Promise<SupportCase>;
  staffMessage(id: string, body: string, expectedVersion?: number): Promise<Message>;
  acquireTurn(caseId: string, runId: string): Promise<TurnLease | null>;
  assertTurn(lease: TurnLease): Promise<boolean>;
  releaseTurn(lease: TurnLease): Promise<void>;
  enqueueTurn(caseId: string, customerId: string, body: string, clientMessageId?: string): Promise<AcceptedTurn>;
  pendingTurnJobs(limit?: number): Promise<SupportTurnJob[]>;
  activeTurnJob(caseId: string): Promise<SupportTurnJob | null>;
  claimTurnJob(id: string, workerId: string): Promise<{job:SupportTurnJob;lease:TurnLease}|null>;
  heartbeatTurnJob(lease: TurnLease): Promise<boolean>;
  failTurnJob(lease: TurnLease, error: string, retry: boolean): Promise<void>;
  completeTurn(lease: TurnLease, patch: CasePatch, body: string, sourceRefs?: Message['sourceRefs'], context?: TurnContext): Promise<{ case: SupportCase; reply: Message } | null>;
  addMessage(caseId: string, role: MessageRole, body: string): Promise<Message>;
  messages(caseId: string): Promise<Message[]>;
  createProposal(proposal: NewProposal, lease?: TurnLease): Promise<Proposal>;
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
  recordRun(run: Omit<AgentRun, 'id' | 'createdAt'>): Promise<AgentRun>;
  runs(caseId?: string): Promise<AgentRun[]>;
  metrics(): Promise<Metrics>;
  knowledge(businessId: string): Promise<KnowledgeSource[]>;
  saveKnowledge(source: KnowledgeSource, expectedVersion?: number): Promise<KnowledgeSource>;
  /** Every saved version of one source, newest first. */
  knowledgeVersions(businessId: string, id: string): Promise<KnowledgeSource[]>;
  skills(businessId: string): Promise<SupportSkill[]>;
  saveSkill(skill: SupportSkill): Promise<SupportSkill>;
  settings(businessId: string): Promise<SupportSettings>;
  classificationState(businessId: string): Promise<ClassificationState>;
  saveSettings(settings: SupportSettings, expectedVersion: number): Promise<SupportSettings>;
}
const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
export class MemorySupportStore implements SupportStore {
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
  constructor(seed?: SeedData) { if (seed) void this.reset(seed); }
  async reset(seed: SeedData) {
    this.businesses = new Map(seed.businesses.map(b => [b.id, copy(b)]));
    this.customers = new Map(seed.customers.map(c => [c.id, copy(c)]));
    this.paymentRows = new Map(seed.payments.map(p => [p.id, copy(p)]));
    this.cases.clear(); this.messageRows = []; this.proposalRows.clear();
    this.refundRows = []; this.auditRows = []; this.runRows = [];
    this.turns.clear(); this.executionPayments.clear(); this.knowledgeRows.clear(); this.knowledgeHistory = []; this.skillRows.clear(); this.settingRows.clear();
    this.turnJobs.clear(); this.clientMessages.clear();
  }
  async seedIfEmpty(seed: SeedData) { if (!this.businesses.size) await this.reset(seed); }
  async recoverInterruptedExecutions() {
    for(const proposal of this.proposalRows.values()) if(proposal.status==='executing' && proposal.decidedAt && Date.now()-Date.parse(proposal.decidedAt)>180000) {
      Object.assign(proposal,{status:'unknown',error:'Execution confirmation was interrupted; manual reconciliation required'});
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
    Object.assign(row,copy(patch),{updatedAt:now()}); return copy(row);
  }
  async setOwnership(id: string, ownership: 'bot'|'staff', actor: string, expectedVersion?: number) {
    const row = this.cases.get(id); if (!row) throw new Error('Case not found');
    if (expectedVersion !== undefined && row.ownershipVersion !== expectedVersion) throw new VersionConflict('Conversation ownership changed');
    row.ownership=ownership; row.ownershipVersion++; row.assignedTo=ownership==='staff'?actor:null; row.updatedAt=now();
    this.turns.delete(id);
    for(const job of this.turnJobs.values()) if(job.caseId===id && ['queued','running'].includes(job.status)) Object.assign(job,{status:'cancelled',workerId:null,leaseExpiresAt:null,updatedAt:now()});
    // A handoff revokes decisions prepared under the previous ownership.
    for (const proposal of this.proposalRows.values()) if (proposal.caseId===id && ['pending','approved'].includes(proposal.status)) Object.assign(proposal,{status:'rejected',error:'Conversation ownership changed'});
    return copy(row);
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
    if (supportCase.ownership === 'staff') return { case: copy(supportCase), message: copy(message), job: null };
    const job: SupportTurnJob = { id: randomUUID(), caseId, customerId, customerMessageId: message.id, body,
      ownershipVersion: supportCase.ownershipVersion, status: 'queued', attempts: 0, fence: 0, workerId: null,
      leaseExpiresAt: null, availableAt: now(), error: null, createdAt: now(), updatedAt: now() };
    this.turnJobs.set(job.id, job);
    return { case: copy(supportCase), message: copy(message), job: copy(job) };
  }
  async pendingTurnJobs(limit = 50) {
    return copy([...this.turnJobs.values()].filter(job => (job.status === 'queued' && Date.parse(job.availableAt) <= Date.now()) || (job.status === 'running' && Date.parse(job.leaseExpiresAt ?? '') <= Date.now())).sort((a,b) => a.createdAt.localeCompare(b.createdAt)).slice(0,limit));
  }
  async activeTurnJob(caseId: string) { return copy([...this.turnJobs.values()].find(job => job.caseId === caseId && ['queued','running'].includes(job.status)) ?? null); }
  async claimTurnJob(id: string, workerId: string) {
    const job = this.turnJobs.get(id);
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
    if (sourceRefs.some(ref=>{ const source=this.knowledgeRows.get(ref.id); return !source || source.version!==ref.version || source.status!=='published' || source.businessId!==this.cases.get(lease.caseId)?.businessId; })) return null;
    if(context && (JSON.stringify(this.businesses.get(this.cases.get(lease.caseId)!.businessId)?.policy)!==JSON.stringify(context.policy) || context.skills.some(ref=>{const skill=this.skillRows.get(ref.id);return !skill || !skill.enabled || skill.revision!==ref.revision;}))) return null;
    if (context && !sameClassificationConfig(visibleClassification(this.settingRows.get(this.cases.get(lease.caseId)!.businessId)?.classification), context.classification)) return null;
    const row=this.cases.get(lease.caseId)!;
    Object.assign(row,copy(patch),{updatedAt:now()});
    if (patch.ownership==='staff') {
      row.ownershipVersion++; row.assignedTo='queue:tier-2';
      for(const proposal of this.proposalRows.values()) if(proposal.caseId===lease.caseId && ['pending','approved'].includes(proposal.status)) Object.assign(proposal,{status:'rejected',error:'Conversation handed to staff'});
    }
    const message: Message={id:randomUUID(),caseId:lease.caseId,role:'assistant',body,createdAt:now(),sourceRefs:copy(sourceRefs)};
    this.messageRows.push(message); const reply=copy(message);
    if (lease.jobFence !== undefined) {
      Object.assign(this.turnJobs.get(lease.runId)!, { status: 'completed', workerId: null, leaseExpiresAt: null, updatedAt: now() });
      this.turns.delete(lease.caseId);
    }
    return {case:copy(row),reply};
  }
  async addMessage(caseId: string, role: MessageRole, body: string) {
    const row:Message={id:randomUUID(),caseId,role,body,createdAt:now()}; this.messageRows.push(row); return copy(row);
  }
  async messages(caseId: string) { return copy(this.messageRows.filter(m=>m.caseId===caseId)); }
  async createProposal(proposal: NewProposal, lease?: TurnLease) {
    if (lease && !this.activeTurn(lease)) throw new StaleTurn('Conversation ownership changed');
    if(lease?.jobFence!==undefined) {
      const previous=[...this.proposalRows.values()].find(row=>row.turnJobId===lease.runId && row.tool===proposal.tool);
      if(previous) { if(previous.argsHash!==proposal.argsHash) throw new StaleTurn('Recovered action arguments changed; staff review required');return copy(previous); }
    }
    const row:Proposal={...copy(proposal),turnJobId:lease?.jobFence!==undefined?lease.runId:null,id:randomUUID(),decidedBy:null,decidedAt:null,result:null,error:null,createdAt:now()};
    this.proposalRows.set(row.id,row); return copy(row);
  }
  async proposal(id: string) { return copy(this.proposalRows.get(id) ?? null); }
  async proposals(caseId: string) { return copy([...this.proposalRows.values()].filter(p=>p.caseId===caseId)); }
  async decideProposal(id: string, argsHash: string, decision:'approved'|'rejected', actor:string) {
    const row=this.proposalRows.get(id);
    if (!row || row.status!=='pending' || row.argsHash!==argsHash) return null;
    Object.assign(row,{status:decision,decidedBy:actor,decidedAt:now()}); return copy(row);
  }
  async claimExecution(id:string,argsHash:string,actor:string) {
    const row=this.proposalRows.get(id);
    if (!row || row.argsHash!==argsHash || row.status!=='approved' || !row.decidedAt || Date.now()-Date.parse(row.decidedAt)>15*60*1000) return null;
    if (row.tool==='refund_payment') {
      const paymentId=String(row.args.payment_id);
      if (this.executionPayments.has(paymentId)) return null;
      this.executionPayments.set(paymentId,row.id);
    }
    row.status='executing'; row.decidedBy=actor; row.decidedAt=now(); return copy(row);
  }
  async claimProposal(id:string,argsHash:string,to:'executing'|'rejected',actor:string) {
    if (to==='rejected') return this.decideProposal(id,argsHash,'rejected',actor);
    const row=this.proposalRows.get(id);
    if (!row || row.tool!=='escalate_to_human' || row.status!=='pending' || row.argsHash!==argsHash) return null;
    Object.assign(row,{status:to,decidedBy:actor,decidedAt:now()}); return copy(row);
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
  async recordRun(run:Omit<AgentRun,'id'|'createdAt'>) { const row={...copy(run),id:randomUUID(),createdAt:now()}; this.runRows.push(row); return copy(row); }
  async runs(caseId?:string) { return copy(this.runRows.filter(r=>!caseId || r.caseId===caseId)); }
  async metrics():Promise<Metrics> {
    const cases=[...this.cases.values()];
    const count=<K extends string>(keys:K[],values:K[])=>Object.fromEntries(keys.map(k=>[k,values.filter(v=>v===k).length])) as Record<K,number>;
    const timed=this.runRows.filter(r=>r.status!=='failed');
    return { cases:cases.length,byStatus:count<CaseStatus>(['open','awaiting_approval','escalated','resolved'],cases.map(c=>c.status)),byPriority:count<Priority>(['P1','P2','P3'],cases.map(c=>c.priority)),
      proposals:count<ProposalStatus>(['pending','approved','executing','executed','rejected','failed','denied','unknown'],[...this.proposalRows.values()].map(p=>p.status)),
      refundsIssuedCents:this.refundRows.reduce((s,r)=>s+r.amountCents,0),agentRuns:this.runRows.length,fallbackRuns:this.runRows.filter(r=>r.status==='fallback').length,
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
  async saveSkill(skill:SupportSkill) { this.skillRows.set(skill.id,copy(skill)); return copy(skill); }
  async settings(businessId:string):Promise<SupportSettings> {
    const stored=this.settingRows.get(businessId); if (stored) return copy({ ...stored, classification: visibleClassification(stored.classification) });
    const business=this.businesses.get(businessId); if (!business) throw new Error('Business not found');
    return {businessId,version:1,language:'uk',tone:'empathetic',requireApproval:true,...copy(business.policy)};
  }
  async classificationState(businessId:string) { return classificationState(this.settingRows.get(businessId)?.classification); }
  async saveSettings(settings:SupportSettings,expectedVersion:number) {
    const old = this.settingRows.get(settings.businessId);
    if ((old?.version ?? 1)!==expectedVersion) throw new VersionConflict('Settings version changed');
    if (!canReplaceClassification(old?.classification, settings.classification)) throw new VersionConflict('Classification changes require a newer revision');
    const classification = storedClassification(old?.classification, settings.classification);
    this.settingRows.set(settings.businessId,copy({ ...settings, classification }));
    settings = { ...settings, classification: visibleClassification(classification) };
    const business=this.businesses.get(settings.businessId)!;
    business.policy={refundLimitCents:settings.refundLimitCents,duplicateWindowMinutes:settings.duplicateWindowMinutes,enabledTools:copy(settings.enabledTools)};
    return copy(settings);
  }
}
