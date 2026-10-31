import { createHash } from 'node:crypto';
import type { Analysis, CaseDetail, Customer, Proposal, SupportCase, TurnResult } from '../support/contracts.js';
import type { PaymentProvider } from '../support/payment-provider.js';
import type { SupportStore } from '../support/store.js';
import { decisionSchema, type AgentContext, type AgentDecision, type AgentModel } from './model.js';
import { evaluatePolicy, money, type PolicyContext } from './policy.js';
import { lexicalSentiment, mergeSentiment, priorityFor, toneFor } from './sentiment.js';
import { TOOLS, isToolName } from './tools.js';

export class HarnessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface HarnessDeps {
  store: SupportStore;
  model: AgentModel;       // primary (LLM or rules)
  fallback: AgentModel;    // deterministic rules, used when the primary fails
  provider: PaymentProvider;
  timeoutMs: number;
}

export function argsHash(caseId: string, tool: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([caseId, tool, canonical(args)])).digest('hex');
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

const CLAIMS_SUCCESS = /(refund(ed)? (has been|was|is) (issued|processed|completed|sent)|we('ve| have) refunded|money (has been|was) returned|кошти (вже )?повернено|ми повернули|повернення (виконано|оформлено))/i;

export class SupportHarness {
  constructor(private readonly deps: HarnessDeps) {}

  async customer(sessionToken: string | undefined): Promise<Customer> {
    const customer = sessionToken ? await this.deps.store.customerBySession(sessionToken) : null;
    if (!customer) throw new HarnessError(401, 'Unknown customer session');
    return customer;
  }

  async openCase(sessionToken: string | undefined): Promise<SupportCase> {
    const customer = await this.customer(sessionToken);
    const created = await this.deps.store.createCase(customer.businessId, customer.id);
    await this.deps.store.audit(created.id, 'case.opened', `customer:${customer.id}`);
    return created;
  }

  async customerCase(sessionToken: string | undefined, caseId: string) {
    const customer = await this.customer(sessionToken);
    const found = await this.deps.store.getCase(caseId);
    if (!found || found.customerId !== customer.id) throw new HarnessError(404, 'Case not found');
    return { customer, supportCase: found, messages: await this.deps.store.messages(caseId) };
  }

  /** One customer message -> one bounded agent run -> at most one proposal. */
  async runTurn(sessionToken: string | undefined, caseId: string, body: string): Promise<TurnResult> {
    const { store } = this.deps;
    const { customer } = await this.customerCase(sessionToken, caseId);
    const business = (await store.business(customer.businessId))!;
    await store.addMessage(caseId, 'customer', body);
    await store.audit(caseId, 'message.received', `customer:${customer.id}`, { length: body.length });

    const ctx: AgentContext = {
      customer: { name: customer.name, plan: customer.plan },
      business: { name: business.name, currency: business.currency, policy: business.policy },
      payments: await store.payments(customer.id, 10),
      history: (await store.messages(caseId)).slice(-10).map(m => ({ role: m.role, body: m.body })),
      message: body,
      allowedTools: business.policy.enabledTools,
    };

    const { decision, source, model } = await this.decide(caseId, ctx);
    const sentiment = mergeSentiment(lexicalSentiment(body), decision.sentiment);
    const analysis: Analysis = {
      intent: decision.intent, summary: decision.summary, reasoning: decision.reasoning, sentiment,
      priority: priorityFor(sentiment, decision.intent), tone: toneFor(sentiment), source, model,
    };
    await store.updateCase(caseId, { intent: analysis.intent, analysis, priority: analysis.priority });
    await store.audit(caseId, 'agent.analyzed', `agent:${model}`, { intent: analysis.intent, sentiment: sentiment.label, priority: analysis.priority, source });

    let action = decision.action;
    if (!action && (sentiment.abusive || sentiment.escalationRisk >= 0.8)) {
      action = { tool: 'escalate_to_human', args: { reason: `High escalation risk (${sentiment.label})` } };
    }
    let proposal: Proposal | null = null;
    if (action) proposal = await this.propose(caseId, customer, action.tool, action.args);
    let escalated = proposal?.status === 'executed' && proposal.tool === 'escalate_to_human';
    if (proposal?.status === 'denied' && proposal.tool !== 'escalate_to_human') {
      const handoff = await this.propose(caseId, customer, 'escalate_to_human', { reason: `Policy denied ${proposal.tool}` });
      escalated = handoff.status === 'executed';
    }

    const status = proposal?.status === 'pending' ? 'awaiting_approval' : escalated ? 'escalated' : 'open';
    const updated = await store.updateCase(caseId, { status });
    const reply = await store.addMessage(caseId, 'assistant', this.compose(decision, analysis, proposal, business.currency, body));
    return { case: updated, reply, proposal };
  }

  private async decide(caseId: string, ctx: AgentContext): Promise<{ decision: AgentDecision; source: Analysis['source']; model: string }> {
    const { model, fallback, store, timeoutMs } = this.deps;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await Promise.race([
        model.decide(ctx, controller.signal),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`LLM timeout after ${timeoutMs} ms`)))),
      ]);
      const decision = decisionSchema.parse(output.decision);
      await store.recordRun({ caseId, provider: model.provider, model: model.model, status: 'ok', steps: output.steps, toolCalls: output.toolCalls, latencyMs: Date.now() - started, error: null });
      return { decision, source: model.provider === 'rules' ? 'fallback' : 'llm', model: model.model };
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Model failed';
      const output = await fallback.decide(ctx, new AbortController().signal);
      await store.recordRun({ caseId, provider: model.provider, model: model.model, status: 'fallback', steps: output.steps, toolCalls: output.toolCalls, latencyMs: Date.now() - started, error: message });
      await store.audit(caseId, 'agent.fallback', 'system', { error: message });
      return { decision: output.decision, source: 'fallback', model: fallback.model };
    } finally { clearTimeout(timer); }
  }

  private async policyContext(caseId: string, customer: Customer): Promise<PolicyContext> {
    const { store } = this.deps;
    return {
      business: (await store.business(customer.businessId))!,
      customer,
      payments: await store.payments(customer.id, 50),
      refunds: await store.refunds(customer.id),
      openProposals: (await store.proposals(caseId)).filter(p => p.status === 'pending' || p.status === 'executing'),
    };
  }

  private async propose(caseId: string, customer: Customer, tool: string, args: Record<string, unknown>): Promise<Proposal> {
    const { store } = this.deps;
    const policy = evaluatePolicy(tool, args, await this.policyContext(caseId, customer));
    const proposal = await store.createProposal({
      caseId, tool, args, argsHash: argsHash(caseId, tool, args),
      risk: isToolName(tool) ? TOOLS[tool].risk : 'high',
      status: policy.allowed ? 'pending' : 'denied', policy,
    });
    await store.audit(caseId, policy.allowed ? 'action.proposed' : 'action.denied', 'agent', { proposalId: proposal.id, tool, failed: policy.checks.filter(c => !c.passed).map(c => c.name) });
    if (policy.allowed && !policy.requiresApproval) {
      const claimed = await store.claimProposal(proposal.id, proposal.argsHash, 'executing', 'agent:auto');
      if (claimed) return (await this.execute(claimed)).proposal;
    }
    return proposal;
  }

  async approve(proposalId: string, operator: string, hash: string) {
    const { store } = this.deps;
    const existing = await store.proposal(proposalId);
    if (!existing) throw new HarnessError(404, 'Proposal not found');
    const claimed = await store.claimProposal(proposalId, hash, 'executing', `operator:${operator}`);
    if (!claimed) {
      throw new HarnessError(409, existing.argsHash !== hash ? 'Approval does not match the proposed operation' : `Proposal is already ${existing.status}`);
    }
    await store.audit(claimed.caseId, 'action.approved', `operator:${operator}`, { proposalId, argsHash: hash });
    return this.execute(claimed);
  }

  async reject(proposalId: string, operator: string, reason: string) {
    const { store } = this.deps;
    const existing = await store.proposal(proposalId);
    if (!existing) throw new HarnessError(404, 'Proposal not found');
    const claimed = await store.claimProposal(proposalId, existing.argsHash, 'rejected', `operator:${operator}`);
    if (!claimed) throw new HarnessError(409, `Proposal is already ${existing.status}`);
    await store.audit(claimed.caseId, 'action.rejected', `operator:${operator}`, { proposalId, reason });
    await store.addMessage(claimed.caseId, 'assistant', 'A support specialist reviewed the request and did not approve an automatic refund. They will contact you with next steps.');
    const supportCase = await store.updateCase(claimed.caseId, { status: 'open' });
    return { proposal: claimed, case: supportCase };
  }

  /** Executes a claimed (status=executing) proposal. Re-validates policy against current state first. */
  private async execute(proposal: Proposal) {
    const { store, provider } = this.deps;
    const supportCase = (await store.getCase(proposal.caseId))!;
    const customer = (await store.customer(supportCase.customerId))!;
    const ctx = await this.policyContext(proposal.caseId, customer);
    ctx.openProposals = ctx.openProposals.filter(p => p.id !== proposal.id);
    const policy = evaluatePolicy(proposal.tool, proposal.args, ctx);
    const finish = async (status: 'executed' | 'failed', result: Record<string, unknown> | null, error: string | null, caseStatus: SupportCase['status'], message: string | null) => {
      const done = await store.finishProposal(proposal.id, status, result, error);
      await store.audit(proposal.caseId, status === 'executed' ? 'action.executed' : 'action.failed', proposal.decidedBy ?? 'system', { proposalId: proposal.id, tool: proposal.tool, result, error });
      if (message) await store.addMessage(proposal.caseId, 'assistant', message);
      return { proposal: done, case: await store.updateCase(proposal.caseId, { status: caseStatus }) };
    };
    if (!policy.allowed) {
      const failed = policy.checks.filter(c => !c.passed).map(c => c.detail).join('; ');
      return finish('failed', null, `Policy re-check failed: ${failed}`, 'open', 'We could not complete this action automatically. A specialist will follow up with you.');
    }
    if (proposal.tool === 'escalate_to_human') {
      // Escalation runs inside runTurn, which composes the customer reply itself.
      return finish('executed', { queue: 'tier-2' }, null, 'escalated', null);
    }
    const args = proposal.args as { payment_id: string; amount_cents: number };
    const payment = ctx.payments.find(p => p.id === args.payment_id)!;
    try {
      const refund = await provider.refund({ paymentId: payment.id, amountCents: payment.amountCents, currency: payment.currency, idempotencyKey: proposal.id });
      const row = await store.recordRefund({ paymentId: payment.id, proposalId: proposal.id, amountCents: payment.amountCents, providerRef: refund.providerRef });
      return finish('executed', { refundId: row.id, providerRef: row.providerRef, amountCents: row.amountCents, simulated: true }, null, 'resolved',
        `Your refund of ${money(row.amountCents, payment.currency)} for the duplicate charge ${payment.merchantRef} has been approved and submitted (reference ${row.providerRef}). It usually appears on your statement within 3–5 business days.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provider error';
      return finish('failed', null, message, 'escalated', 'We tried to process your refund, but the payment provider did not confirm it. No refund has been made yet; a specialist is looking into it now.');
    }
  }

  private compose(decision: AgentDecision, analysis: Analysis, proposal: Proposal | null, currency: string, body: string): string {
    const uk = /[а-яіїєґ]/i.test(body);
    const lead = analysis.tone === 'neutral' ? '' : uk ? 'Мені дуже шкода, що так сталося — розумію, як це неприємно. ' : "I'm really sorry about this — I understand how frustrating it is. ";
    if (proposal?.tool === 'refund_payment' && proposal.status === 'pending') {
      const amount = money(Number(proposal.args.amount_cents), currency);
      return lead + (uk
        ? `Я знайшов два однакові списання і підготував повернення ${amount} за дубль. Його має підтвердити спеціаліст — я напишу тут, щойно буде результат.`
        : `I found two identical charges and prepared a refund of ${amount} for the duplicate. A specialist needs to confirm it before it is processed — I'll update you here.`);
    }
    if (proposal?.status === 'denied') {
      return lead + (uk ? 'Я не можу виконати це автоматично за правилами компанії. Передаю ваше звернення спеціалісту.' : "I can't do this automatically under our policy, so I'm passing your request to a specialist.");
    }
    if (proposal?.tool === 'escalate_to_human' && proposal.status === 'executed') {
      return lead + (uk ? 'Я передав вашу розмову спеціалісту, він відповість тут найближчим часом.' : 'I have passed your conversation to a human specialist. They will reply here shortly.');
    }
    // No executed money movement exists here, so a model reply claiming one is replaced.
    if (!decision.reply || CLAIMS_SUCCESS.test(decision.reply)) {
      return lead + (uk ? 'Дякую! Я перевіряю ваше звернення, спеціаліст підключиться за потреби.' : "Thanks! I'm looking into this and a specialist will join if needed.");
    }
    return decision.reply;
  }

  async detail(caseId: string): Promise<CaseDetail> {
    const { store } = this.deps;
    const supportCase = await store.getCase(caseId);
    if (!supportCase) throw new HarnessError(404, 'Case not found');
    const customer: Partial<Customer> & Omit<Customer, 'sessionToken'> = { ...(await store.customer(supportCase.customerId))! };
    delete customer.sessionToken;
    return {
      case: supportCase, customer,
      payments: await store.payments(customer.id, 20),
      messages: await store.messages(caseId),
      proposals: await store.proposals(caseId),
      audit: await store.auditEvents(caseId),
      runs: await store.runs(caseId),
      refunds: await store.refunds(customer.id),
    };
  }
}
