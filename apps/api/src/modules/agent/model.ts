import { z } from 'zod';
import type { Business, Payment } from '../support/contracts.js';
import { duplicateCandidate } from './policy.js';

// Controlled context: built by the harness from backend state, never from customer-supplied ids.
export interface AgentContext {
  customer: { name: string; plan: string };
  business: Pick<Business, 'name' | 'currency' | 'policy'>;
  payments: Payment[];
  history: { role: string; body: string }[];
  message: string;
  allowedTools: string[];
}

export const decisionSchema = z.object({
  intent: z.enum(['duplicate_charge', 'refund_request', 'billing_question', 'cancel_subscription', 'complaint', 'other']),
  summary: z.string().max(400).describe('One-sentence summary of the customer problem for the operator'),
  reasoning: z.string().max(800).describe('Short justification grounded in the payments you looked up'),
  sentiment: z.object({
    label: z.enum(['calm', 'frustrated', 'angry', 'abusive']),
    urgency: z.enum(['low', 'medium', 'high']),
  }),
  reply: z.string().max(1200).describe('Reply to the customer in their language. Never claim an action was completed.'),
  action: z.object({
    tool: z.string().describe('refund_payment or escalate_to_human'),
    args: z.record(z.string(), z.unknown()),
  }).nullable().describe('Proposed write action, or null'),
});
export type AgentDecision = z.infer<typeof decisionSchema>;

export interface ModelOutput { decision: AgentDecision; steps: number; toolCalls: string[] }
export interface AgentModel {
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
const ukrainian = (text: string) => /[а-яіїєґ]/i.test(text);

/** Keyword fallback used when no LLM is configured or the LLM fails. Labelled "fallback" in the UI. */
export class RulesModel implements AgentModel {
  readonly provider = 'rules';
  readonly model = 'keyword-rules-v1';
  async decide(ctx: AgentContext): Promise<ModelOutput> {
    const text = ctx.message;
    const uk = ukrainian(text);
    const base = { sentiment: { label: 'calm' as const, urgency: 'low' as const } };
    if (has(text, /twice|double|duplicate|two times|двічі|подвійн|дубл|два рази|двічі/)) {
      const twin = duplicateCandidate(ctx.payments, ctx.business.policy.duplicateWindowMinutes);
      if (!twin) return out({ ...base, intent: 'duplicate_charge', summary: 'Customer reports a duplicate charge; no duplicate found.', reasoning: 'No two identical captured payments within the duplicate window.', reply: uk ? 'Я не бачу двох однакових списань у вашій історії. Підкажіть, будь ласка, дату та суму списання?' : "I can't find two identical charges on your account. Could you tell me the date and amount of the charge?", action: null });
      return out({ ...base, intent: 'duplicate_charge', summary: `Duplicate charge ${twin.merchantRef}.`, reasoning: `Two identical captured payments for ${twin.merchantRef}; proposing to refund the later one.`, reply: '', action: { tool: 'refund_payment', args: { payment_id: twin.id, amount_cents: twin.amountCents } } });
    }
    if (has(text, /cancel|скасу|відпис/)) return out({ ...base, intent: 'cancel_subscription', summary: 'Customer wants to cancel the subscription.', reasoning: 'Cancellation is not an automated action; route to a human.', reply: '', action: { tool: 'escalate_to_human', args: { reason: 'Subscription cancellation request' } } });
    if (has(text, /refund|money back|поверн/)) return out({ ...base, intent: 'refund_request', summary: 'Customer asks for a refund.', reasoning: 'Non-duplicate refunds need a human decision.', reply: '', action: { tool: 'escalate_to_human', args: { reason: 'Refund request outside the duplicate-charge policy' } } });
    return out({ ...base, intent: 'other', summary: 'General question.', reasoning: 'No supported action matches.', reply: uk ? 'Дякую за звернення! Уточніть, будь ласка, з чим саме допомогти?' : 'Thanks for reaching out! Could you tell me a bit more about what you need?', action: null });
  }
}

const out = (decision: AgentDecision): ModelOutput => ({ decision, steps: 1, toolCalls: [] });
