import type { NewActivity } from '../support/activity.js';
import { requestTargetsSchema, type RequestCatalog, type RequestCheckpoint, type RequestTarget } from '../support/requests/contracts.js';
import { z } from 'zod';
import type { Business, Payment } from '../support/contracts.js';
import { duplicateCandidate } from './policy.js';
import type { ClassificationConfig } from './classification.js';
import type { SupportContextCatalog, SupportContextDetails, SupportContextMemory, SupportContextRequest } from './context.js';
import { conversationLanguage, customerMessages } from './communication.js';

// Controlled context: built by the harness from backend state, never from customer-supplied ids.
export interface AgentContext {
  contextCatalog?: SupportContextCatalog;
  contextMemory?: SupportContextMemory;
  loadSupportContext?: (request: SupportContextRequest, signal?: AbortSignal) => Promise<SupportContextDetails>;
  callBusinessTools?: (calls: { integrationId: string; name: string; input: Record<string, unknown>; requests?: RequestTarget[] }[], signal?: AbortSignal) => Promise<{ results: { integrationId: string; name: string; result: unknown }[] }>;
  activityRunId?:string;
  recordActivity?: (event:NewActivity)=>Promise<void>;
  currentCustomerMessageId?: string;
  requestCatalog?: () => RequestCatalog;
  requestSourceMessages?: {id:string;body:string}[];
  checkpointRequests?: (batch: RequestCheckpoint) => Promise<RequestCatalog>;
  ensureRequestCheckpoint?: () => Promise<void>;
  requestCheckpointAccepted?: () => boolean;
  conversationId: string;
  runId: string;
  runtimeAttempt?: number;
  /** External sources are fetched afresh: never replay a previous native tool result. */
  knowledgeSessionKey?: string;
  turnJobId?: string;
  businessId: string;
  ownershipVersion: number;
  assertActive: () => Promise<void>;
  knowledge: { id: string; title: string; content: string; version: number }[];
  skills: { id: string; name: string; content: string; revision: number }[];
  searchKnowledge: (query: string, signal?: AbortSignal) => Promise<{ id: string; title: string; content: string; version: number }[]>;
  businessTools?: { integrationId: string; name: string; description: string; inputSchema: Record<string, unknown> }[];
  callBusinessTool?: (integrationId: string, name: string, input: Record<string, unknown>, signal?: AbortSignal, requests?: RequestTarget[]) => Promise<unknown>;
  /** Application-owned control state; never infer a pending proposal from business JSON. */
  readonly pendingApproval?: () => { proposalId: string; summary: string } | undefined;
  customer: { name: string; plan: string };
  business: Pick<Business, 'name' | 'currency' | 'policy'>;
  operatorLanguage?: 'uk' | 'en';
  payments: Payment[];
  history: { role: string; body: string }[];
  message: string;
  allowedTools: string[];
  classification?: ClassificationConfig | null;
}

export const decisionSchema = z.object({
  // Independently normalized against the current business taxonomy by the backend.
  classification: z.unknown().optional(),
  intent: z.enum(['duplicate_charge', 'refund_request', 'billing_question', 'cancel_subscription', 'complaint', 'other']),
  summary: z.string().max(400).describe('One-sentence summary of the customer problem for the operator'),
  reasoning: z.string().max(800).describe('Short justification grounded in the payments you looked up'),
  sentiment: z.object({
    label: z.enum(['calm', 'frustrated', 'angry', 'abusive']),
    urgency: z.enum(['low', 'medium', 'high']),
  }),
  reply: z.string().max(1200).describe('Reply to the customer in their language. Never claim an action was completed.'),
  replyLanguage: z.string().max(35).regex(/^[a-z]{2,3}(?:-[a-z\d]{2,8})*$/i).optional().describe('BCP 47 language code of the customer reply, independent of operatorLanguage'),
  action: z.object({
    requests: requestTargetsSchema.optional(),
    tool: z.string().describe('refund_payment or escalate_to_human'),
    args: z.record(z.string(), z.unknown()),
  }).nullable().describe('Proposed write action, or null'),
});
export type AgentDecision = z.infer<typeof decisionSchema>;

export interface ModelOutput { decision: AgentDecision; steps: number; toolCalls: string[] }
export interface AgentModel {
  readonly contextProtocol?: 'catalog-v1';
  readonly requestCatalogProtocol?: 'checkpoint-v1';
  readonly provider: string;
  readonly model: string;
  decide(ctx: AgentContext, signal: AbortSignal): Promise<ModelOutput>;
}

/** Deterministic tests: returns whatever the script says (or throws). */
export class ScriptedModel implements AgentModel {
  readonly provider = 'scripted';
  readonly model = 'scripted';
  calls = 0;
  constructor(private readonly script: (ctx: AgentContext) => AgentDecision | Promise<AgentDecision>) {}
  async decide(ctx: AgentContext): Promise<ModelOutput> {
    this.calls++;
    return { decision: await this.script(ctx), steps: 1, toolCalls: [] };
  }
}

const has = (text: string, pattern: RegExp) => pattern.test(text.toLowerCase());

/** Keyword fallback used when no LLM is configured or the LLM fails. Labelled "fallback" in the UI. */
export class RulesModel implements AgentModel {
  readonly provider = 'rules';
  readonly model = 'keyword-rules-v1';
  async decide(ctx: AgentContext, signal?: AbortSignal): Promise<ModelOutput> {
    const text = ctx.message;
    const replyLanguage = conversationLanguage(text, ctx.history) ?? 'en';
    const messages = customerMessages(replyLanguage);
    const staffUk = ctx.operatorLanguage === 'uk';
    const base = { replyLanguage, sentiment: { label: 'calm' as const, urgency: 'low' as const } };
    const sources = await ctx.searchKnowledge(text, signal);
    if (sources.length && !has(text, /twice|double|duplicate|двічі|подвійн|refund|поверн|cancel|скасу/)) {
      const source = sources[0]!;
      const sourceLanguage = conversationLanguage(source.content);
      return out({ ...base, intent: 'other', summary: source.title,
        reasoning: staffUk ? 'Знайдено опублікований документ компанії.' : 'Found a published business document.',
        reply: !sourceLanguage || sourceLanguage === replyLanguage ? source.content.slice(0, 1000) + '\n\n[' + source.title + '] (' + source.id + ', v' + source.version + ')' : messages.fallback,
        action: null });
    }
    if (has(text, /twice|double|duplicate|two times|двічі|подвійн|дубл|два рази|двічі/)) {
      const twin = duplicateCandidate(ctx.payments, ctx.business.policy.duplicateWindowMinutes);
      if (!twin) return out({ ...base, intent: 'duplicate_charge', summary: staffUk ? 'Клієнт повідомив про подвійне списання.' : 'Customer reports a duplicate charge.', reasoning: staffUk ? 'Два однакові списання у визначеному інтервалі не знайдено.' : 'No two identical captured payments within the duplicate window.', reply: messages.billing, action: null });
      return out({ ...base, intent: 'duplicate_charge', summary: staffUk ? `Подвійне списання ${twin.merchantRef}.` : `Duplicate charge ${twin.merchantRef}.`, reasoning: staffUk ? 'Знайдено два однакові списання. Пропоную повернути друге.' : 'Two identical captured payments found. Proposing to refund the later one.', reply: '', action: { tool: 'refund_payment', args: { payment_id: twin.id, amount_cents: twin.amountCents } } });
    }
    if (has(text, /cancel|скасу|відпис/)) {
      const summary = staffUk ? 'Клієнт просить скасувати підписку.' : 'Customer wants to cancel the subscription.';
      return out({ ...base, intent: 'cancel_subscription', summary, reasoning: staffUk ? 'Запит має розглянути спеціаліст.' : 'A specialist must review the request.', reply: '', action: { tool: 'escalate_to_human', args: { reason: summary } } });
    }
    if (has(text, /refund|money back|поверн/)) {
      const summary = staffUk ? 'Клієнт просить повернення.' : 'Customer asks for a refund.';
      return out({ ...base, intent: 'refund_request', summary, reasoning: staffUk ? 'Повернення без підтвердженого дубля потребує рішення спеціаліста.' : 'Refunds without a confirmed duplicate need a specialist’s decision.', reply: '', action: { tool: 'escalate_to_human', args: { reason: summary } } });
    }
    return out({ ...base, intent: 'other', summary: staffUk ? 'Загальне запитання.' : 'General question.', reasoning: staffUk ? 'Потрібно уточнити запит.' : 'The request needs clarification.', reply: messages.clarify, action: null });
  }
}

const out = (decision: AgentDecision): ModelOutput => ({ decision, steps: 1, toolCalls: [] });
