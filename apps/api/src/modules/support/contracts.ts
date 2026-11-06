import type { RequestCatalog } from './requests/contracts.js';
export type { RequestCatalog, CustomerRequest, RequestEvent, RequestTarget } from './requests/contracts.js';
import type { ClassificationConfig, TicketClassification } from '../agent/classification.js';
import type { ExternalKnowledgeRef } from '../knowledge/qdrant.js';

// Shared support contracts. Owner: WS1. Change only through the integration owner;
// apps/frontend/src/lib/api.ts mirrors these types.

export type Intent = 'duplicate_charge' | 'refund_request' | 'billing_question' | 'cancel_subscription' | 'complaint' | 'other';
export type CaseStatus = 'open' | 'awaiting_approval' | 'escalated' | 'resolved';
export type Priority = 'P1' | 'P2' | 'P3';
export type MessageRole = 'customer' | 'assistant' | 'operator' | 'system';
export type ProposalStatus = 'pending' | 'approved' | 'executing' | 'executed' | 'rejected' | 'failed' | 'denied' | 'unknown' | 'expired' | 'invalidated';
export type Risk = 'low' | 'high';

export interface Policy {
  refundLimitCents: number;
  duplicateWindowMinutes: number;
  enabledTools: string[];
}

export interface Business { id: string; slug: string; name: string; currency: string; policy: Policy }
export interface Customer { id: string; businessId: string; name: string; email: string; plan: string; sessionToken: string }
export interface Payment {
  id: string; customerId: string; amountCents: number; currency: string;
  merchantRef: string; description: string; status: 'captured' | 'refunded'; createdAt: string;
}

export interface Sentiment {
  label: 'calm' | 'frustrated' | 'angry' | 'abusive';
  frustration: number;       // 0..1
  abusive: boolean;
  urgency: 'low' | 'medium' | 'high';
  escalationRisk: number;    // 0..1
  signals: string[];         // human-readable evidence shown in the dashboard
}

export interface Analysis {
  intent: Intent;
  summary: string;
  reasoning: string;
  sentiment: Sentiment;
  priority: Priority;
  tone: 'neutral' | 'empathetic' | 'de-escalating';
  source: 'llm' | 'fallback';
  model: string;
  classification?: TicketClassification | null;
}

export interface SupportCase {
  id: string; businessId: string; customerId: string; customerName: string;
  status: CaseStatus; priority: Priority; intent: Intent | null; analysis: Analysis | null;
  createdAt: string; updatedAt: string;
  ownership: 'bot' | 'staff'; ownershipVersion: number; assignedTo: string | null;
}

export interface TurnLease { caseId: string; runId: string; ownershipVersion: number; jobFence?: number; workerId?: string }
export interface SupportTurnJob {
  id: string; caseId: string; customerId: string; customerMessageId: string; body: string;
  ownershipVersion: number; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempts: number; fence: number; workerId: string | null; leaseExpiresAt: string | null;
  availableAt: string; error: string | null; createdAt: string; updatedAt: string;
}
export interface AcceptedTurn { case: SupportCase; message: Message; job: SupportTurnJob | null }
export interface KnowledgeSource {
  id: string; businessId: string; title: string; category: string; content: string; version: number;
  status: 'draft' | 'published' | 'revoked'; updatedAt: string;
  /** 'internal' sources are for staff and never reach the customer-facing agent. Default 'customer'. */
  audience?: 'customer' | 'internal';
  /** Empty or missing: every plan. Otherwise only customers on one of these plans. */
  plans?: string[];
  sourceUrl?: string | null;
}
export interface SupportSkill { id: string; businessId: string; name: string; content: string; revision: number; enabled: boolean; updatedAt: string }
export interface SupportSettings {
  businessId: string; version: number; language: string; tone: 'neutral' | 'empathetic' | 'de-escalating';
  requireApproval: true; refundLimitCents: number; duplicateWindowMinutes: number; enabledTools: string[];
  classification?: ClassificationConfig | null;
}

export interface Message { id: string; caseId: string; role: MessageRole; body: string; createdAt: string; sourceRefs?: { id: string; version: number }[]; externalSourceRefs?: ExternalKnowledgeRef[] }

export interface PolicyCheck { name: string; passed: boolean; detail: string }
export interface PolicyResult { allowed: boolean; requiresApproval: boolean; checks: PolicyCheck[] }

export interface Proposal {
  authorizationOrigin?: 'policy_auto' | 'operator_approval' | null;
  turnJobId?: string | null;
  id: string; caseId: string; tool: string; args: Record<string, unknown>; argsHash: string;
  risk: Risk; status: ProposalStatus; policy: PolicyResult;
  decidedBy: string | null; decidedAt: string | null;
  result: Record<string, unknown> | null; error: string | null; createdAt: string;
}

export interface Refund { id: string; paymentId: string; proposalId: string; amountCents: number; providerRef: string; simulated: true; createdAt: string }
export interface AuditEvent { id: string; caseId: string; type: string; actor: string; data: Record<string, unknown>; createdAt: string }
export interface AgentRun {
  turnJobId?: string | null;
  id: string; caseId: string; provider: string; model: string; status: 'ok' | 'failed' | 'fallback';
  steps: number; toolCalls: string[]; latencyMs: number; error: string | null; createdAt: string;
}

export interface CaseDetail {
  requestCatalog: RequestCatalog;
  activeRun?: { id: string; status: SupportTurnJob['status'] } | null;
  case: SupportCase; customer: Omit<Customer, 'sessionToken'>; payments: Payment[];
  messages: Message[]; proposals: Proposal[]; audit: AuditEvent[]; runs: AgentRun[]; refunds: Refund[];
}

export interface TurnResult { case: SupportCase; reply: Message | null; proposal: Proposal | null }

export interface Metrics {
  cases: number; byStatus: Record<CaseStatus, number>; byPriority: Record<Priority, number>;
  proposals: Record<ProposalStatus, number>; refundsIssuedCents: number;
  agentRuns: number; fallbackRuns: number; avgAgentLatencyMs: number | null;
}
