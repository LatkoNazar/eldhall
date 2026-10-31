import { generateText, stepCountIs, tool, type LanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { decisionSchema, type AgentContext, type AgentModel, type ModelOutput } from './model.js';
import { TOOLS } from './tools.js';

export const DEFAULT_MODELS = { openai: 'gpt-5-mini', google: 'gemini-2.5-flash', anthropic: 'claude-haiku-5-5' } as const;
export type Provider = keyof typeof DEFAULT_MODELS;

const MAX_STEPS = 4;

const SYSTEM = `You are the AI support copilot of {business}. You analyse a customer message and decide the next step.
Rules:
- Call lookup_payments before making any claim about charges. Use only payment ids returned by it.
- You can only PROPOSE actions via submit_decision.action. You never execute anything; the backend validates policy and a human approves money movements.
- Allowed actions: {tools}. Refunds are only for duplicate charges (same merchant reference and amount within {window} minutes); refund the later charge, full amount.
- Escalate to a human for cancellations, other refunds, abusive conversations or when unsure.
- Frustration is not malice: stay calm and polite. Sentiment never justifies a refund on its own.
- Reply in the customer's language. Never say a refund was issued or money was returned.
- Finish by calling submit_decision exactly once.`;

export class AiSdkModel implements AgentModel {
  readonly provider: Provider;
  readonly model: string;
  private readonly languageModel: LanguageModel;

  constructor(provider: Provider, model?: string) {
    this.provider = provider;
    this.model = model || DEFAULT_MODELS[provider];
    this.languageModel = { openai, google, anthropic }[provider](this.model);
  }

  async decide(ctx: AgentContext, signal: AbortSignal): Promise<ModelOutput> {
    const actions = ctx.allowedTools.filter(name => name !== 'lookup_payments');
    const tools = {
      lookup_payments: tool({
        description: TOOLS.lookup_payments.description,
        inputSchema: TOOLS.lookup_payments.args,
        // Scoped read: payments were loaded for the session customer by the harness.
        execute: async ({ limit }) => ctx.payments.slice(0, limit).map(p => ({ id: p.id, amount: (p.amountCents / 100).toFixed(2), amount_cents: p.amountCents, currency: p.currency, merchant_ref: p.merchantRef, description: p.description, status: p.status, created_at: p.createdAt })),
      }),
      // No execute(): calling it ends the loop and hands the typed decision to the backend.
      submit_decision: tool({ description: 'Submit your final structured decision.', inputSchema: decisionSchema }),
    };
    const result = await generateText({
      model: this.languageModel,
      system: SYSTEM.replace('{business}', ctx.business.name).replace('{tools}', actions.join(', ') || 'none').replace('{window}', String(ctx.business.policy.duplicateWindowMinutes)),
      messages: [
        ...ctx.history.slice(0, -1).map(m => ({ role: m.role === 'customer' ? 'user' as const : 'assistant' as const, content: m.body })),
        { role: 'user', content: `Customer: ${ctx.customer.name} (plan: ${ctx.customer.plan})\nMessage: ${ctx.message}` },
      ],
      tools,
      toolChoice: 'required',
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal,
      maxRetries: 1,
    });
    const toolCalls = result.steps.flatMap(step => step.toolCalls.map(call => call.toolName));
    const final = result.steps.flatMap(step => step.toolCalls).findLast(call => call.toolName === 'submit_decision');
    if (!final) throw new Error(`Model did not submit a decision within ${MAX_STEPS} steps`);
    return { decision: decisionSchema.parse(final.input), steps: result.steps.length, toolCalls };
  }
}
