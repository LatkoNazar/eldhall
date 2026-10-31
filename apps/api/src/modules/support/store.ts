import { randomUUID } from 'node:crypto';
import type {
  AgentRun, AuditEvent, Business, CaseStatus, Customer, Message, MessageRole, Metrics, Payment,
  Priority, Proposal, ProposalStatus, Refund, SupportCase,
} from './contracts.js';
import type { SeedData } from './seed.js';

export type NewProposal = Omit<Proposal, 'id' | 'createdAt' | 'decidedBy' | 'decidedAt' | 'result' | 'error'>;
export type CasePatch = Partial<Pick<SupportCase, 'status' | 'priority' | 'intent' | 'analysis'>>;

export class DuplicateRefund extends Error {}

// Persistence contract for the support domain. Owner: WS1 (interface), WS3 (PostgresSupportStore).
// Every write that matters for money must be atomic in the implementation, not in the caller.
export interface SupportStore {
  reset(seed: SeedData): Promise<void>;
  customerBySession(token: string): Promise<Customer | null>;
  customer(id: string): Promise<Customer | null>;
  business(id: string): Promise<Business | null>;
  payments(customerId: string, limit?: number): Promise<Payment[]>;
  payment(id: string): Promise<Payment | null>;
  createCase(businessId: string, customerId: string): Promise<SupportCase>;
  getCase(id: string): Promise<SupportCase | null>;
  listCases(status?: CaseStatus): Promise<SupportCase[]>;
  updateCase(id: string, patch: CasePatch): Promise<SupportCase>;
  addMessage(caseId: string, role: MessageRole, body: string): Promise<Message>;
  messages(caseId: string): Promise<Message[]>;
  createProposal(proposal: NewProposal): Promise<Proposal>;
  proposal(id: string): Promise<Proposal | null>;
  proposals(caseId: string): Promise<Proposal[]>;
  /** Atomic compare-and-set: moves pending -> `to` only if argsHash matches. Returns null otherwise. */
  claimProposal(id: string, argsHash: string, to: 'executing' | 'rejected', actor: string): Promise<Proposal | null>;
  finishProposal(id: string, status: 'executed' | 'failed', result: Record<string, unknown> | null, error: string | null): Promise<Proposal>;
  /** Must throw DuplicateRefund when the payment or proposal already has a refund; also marks the payment refunded. */
  recordRefund(refund: Omit<Refund, 'id' | 'createdAt' | 'simulated'>): Promise<Refund>;
  refunds(customerId?: string): Promise<Refund[]>;
  audit(caseId: string, type: string, actor: string, data?: Record<string, unknown>): Promise<AuditEvent>;
  auditEvents(caseId: string): Promise<AuditEvent[]>;
  recordRun(run: Omit<AgentRun, 'id' | 'createdAt'>): Promise<AgentRun>;
  runs(caseId?: string): Promise<AgentRun[]>;
  metrics(): Promise<Metrics>;
}

const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);

// Used by unit tests and as the zero-infrastructure demo fallback (SUPPORT_STORE=memory).
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

  constructor(seed?: SeedData) { if (seed) void this.reset(seed); }

  async reset(seed: SeedData) {
    this.businesses = new Map(seed.businesses.map(b => [b.id, copy(b)]));
    this.customers = new Map(seed.customers.map(c => [c.id, copy(c)]));
    this.paymentRows = new Map(seed.payments.map(p => [p.id, copy(p)]));
    this.cases.clear(); this.messageRows = []; this.proposalRows.clear();
    this.refundRows = []; this.auditRows = []; this.runRows = [];
  }
  async customerBySession(token: string) { return copy([...this.customers.values()].find(c => c.sessionToken === token) ?? null); }
  async customer(id: string) { return copy(this.customers.get(id) ?? null); }
  async business(id: string) { return copy(this.businesses.get(id) ?? null); }
  async payments(customerId: string, limit = 10) {
    return copy([...this.paymentRows.values()].filter(p => p.customerId === customerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit));
  }
  async payment(id: string) { return copy(this.paymentRows.get(id) ?? null); }
  async createCase(businessId: string, customerId: string) {
    const customer = this.customers.get(customerId);
    const row: SupportCase = { id: randomUUID(), businessId, customerId, customerName: customer?.name ?? '', status: 'open', priority: 'P3', intent: null, analysis: null, createdAt: now(), updatedAt: now() };
    this.cases.set(row.id, row);
    return copy(row);
  }
  async getCase(id: string) { return copy(this.cases.get(id) ?? null); }
  async listCases(status?: CaseStatus) {
    return copy([...this.cases.values()].filter(c => !status || c.status === status)
      .sort((a, b) => a.priority.localeCompare(b.priority) || b.updatedAt.localeCompare(a.updatedAt)));
  }
  async updateCase(id: string, patch: CasePatch) {
    const row = this.cases.get(id);
    if (!row) throw new Error('Case not found');
    Object.assign(row, patch, { updatedAt: now() });
    return copy(row);
  }
  async addMessage(caseId: string, role: MessageRole, body: string) {
    const row: Message = { id: randomUUID(), caseId, role, body, createdAt: now() };
    this.messageRows.push(row);
    return copy(row);
  }
  async messages(caseId: string) { return copy(this.messageRows.filter(m => m.caseId === caseId)); }
  async createProposal(proposal: NewProposal) {
    const row: Proposal = { ...copy(proposal), id: randomUUID(), decidedBy: null, decidedAt: null, result: null, error: null, createdAt: now() };
    this.proposalRows.set(row.id, row);
    return copy(row);
  }
  async proposal(id: string) { return copy(this.proposalRows.get(id) ?? null); }
  async proposals(caseId: string) { return copy([...this.proposalRows.values()].filter(p => p.caseId === caseId)); }
  async claimProposal(id: string, argsHash: string, to: 'executing' | 'rejected', actor: string) {
    const row = this.proposalRows.get(id);
    if (!row || row.status !== 'pending' || row.argsHash !== argsHash) return null;
    Object.assign(row, { status: to, decidedBy: actor, decidedAt: now() });
    return copy(row);
  }
  async finishProposal(id: string, status: 'executed' | 'failed', result: Record<string, unknown> | null, error: string | null) {
    const row = this.proposalRows.get(id);
    if (!row) throw new Error('Proposal not found');
    Object.assign(row, { status, result, error });
    return copy(row);
  }
  async recordRefund(refund: Omit<Refund, 'id' | 'createdAt' | 'simulated'>) {
    if (this.refundRows.some(r => r.paymentId === refund.paymentId || r.proposalId === refund.proposalId)) throw new DuplicateRefund('Payment already refunded');
    const row: Refund = { ...refund, id: randomUUID(), simulated: true, createdAt: now() };
    this.refundRows.push(row);
    const payment = this.paymentRows.get(refund.paymentId);
    if (payment) payment.status = 'refunded';
    return copy(row);
  }
  async refunds(customerId?: string) {
    return copy(this.refundRows.filter(r => !customerId || this.paymentRows.get(r.paymentId)?.customerId === customerId));
  }
  async audit(caseId: string, type: string, actor: string, data: Record<string, unknown> = {}) {
    const row: AuditEvent = { id: randomUUID(), caseId, type, actor, data: copy(data), createdAt: now() };
    this.auditRows.push(row);
    return copy(row);
  }
  async auditEvents(caseId: string) { return copy(this.auditRows.filter(a => a.caseId === caseId)); }
  async recordRun(run: Omit<AgentRun, 'id' | 'createdAt'>) {
    const row: AgentRun = { ...copy(run), id: randomUUID(), createdAt: now() };
    this.runRows.push(row);
    return copy(row);
  }
  async runs(caseId?: string) { return copy(this.runRows.filter(r => !caseId || r.caseId === caseId)); }
  async metrics(): Promise<Metrics> {
    const cases = [...this.cases.values()];
    const count = <K extends string>(keys: K[], values: K[]) => Object.fromEntries(keys.map(k => [k, values.filter(v => v === k).length])) as Record<K, number>;
    const timed = this.runRows.filter(r => r.status !== 'failed');
    return {
      cases: cases.length,
      byStatus: count<CaseStatus>(['open', 'awaiting_approval', 'escalated', 'resolved'], cases.map(c => c.status)),
      byPriority: count<Priority>(['P1', 'P2', 'P3'], cases.map(c => c.priority)),
      proposals: count<ProposalStatus>(['pending', 'executing', 'executed', 'rejected', 'failed', 'denied'], [...this.proposalRows.values()].map(p => p.status)),
      refundsIssuedCents: this.refundRows.reduce((sum, r) => sum + r.amountCents, 0),
      agentRuns: this.runRows.length,
      fallbackRuns: this.runRows.filter(r => r.status === 'fallback').length,
      avgAgentLatencyMs: timed.length ? Math.round(timed.reduce((s, r) => s + r.latencyMs, 0) / timed.length) : null,
    };
  }
}
