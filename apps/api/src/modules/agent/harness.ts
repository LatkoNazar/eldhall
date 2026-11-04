import { createHash, randomUUID } from 'node:crypto';
import type { Analysis, CaseDetail, Customer, Message, Proposal, SupportCase, SupportTurnJob, TurnLease, TurnResult } from '../support/contracts.js';
import { ProviderError, type PaymentProvider } from '../support/payment-provider.js';
import { StaleTurn, type SupportStore } from '../support/store.js';
import { decisionSchema, type AgentContext, type AgentDecision, type AgentModel } from './model.js';
import { evaluatePolicy, money, type PolicyContext } from './policy.js';
import { lexicalSentiment, mergeSentiment, priorityFor, toneFor } from './sentiment.js';
import { TOOLS, isToolName } from './tools.js';
import type { ActionOutcome, BusinessIntegrations, BusinessToolResult, ExternalActionRequest } from '../../integrations/mcp.js';
import { normalizeClassification, sameClassificationConfig, type TicketClassification, type TicketClassifier } from './classification.js';
import type { KnowledgeRetriever } from '../knowledge/retriever.js';
import { knowledgeRuntime } from '../knowledge/runtime.js';
import type { ExternalKnowledge, ExternalKnowledgeRef } from '../knowledge/qdrant.js';

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
  integrations?: BusinessIntegrations;
  classifier?: TicketClassifier;
  knowledge?: KnowledgeRetriever; // hybrid retrieval over published sources; defaults to the shared in-process index
  externalKnowledge?: ExternalKnowledge;
}

export function argsHash(caseId: string, tool: string, args: unknown): string {
  return createHash('sha256').update(JSON.stringify([caseId, tool, canonical(args)])).digest('hex');
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;

// Model prose may never claim that an action was performed: only server templates built from a recorded
// proposal may say so. Claims about a resulting state ("order is cancelled") are allowed only when this
// turn's business-tool data shows that state, so relaying a real order status still works.
const ACTION_CLAIM = /(refund(?:ed)?\b.{0,40}\b(?:complete|completed|processed|issued|sent|done|successful)|money.{0,30}(?:returned|sent|refunded)|back on your card|already back|subscription\s+(?:has been|was|is)\s+cancell?ed|\b(?:we|i)(?:'ve| have)?\s+(?:just\s+|already\s+)?(?:cancell?ed|refunded|updated|changed|processed|completed|issued|submitted)\b|\b(?:successfully|now)\s+(?:been\s+)?(?:cancell?ed|refunded|updated|changed|processed)\b|\b(?:cancell?ed|refunded|processed|updated|changed)\s+successfully\b|\b(?:cancell?ation|refund|request|change|update)\s+(?:is\s+|has been\s+)?(?:confirmed|complete|completed|processed|done)\b|^\W*done\b|(?<![а-яіїєґ])(?:ми|я)\s+(?:вже\s+|щойно\s+)?(?:скасува|відмінил|відмінив|змінил|змінив|оновил|оновив|оформил|оформив|виконал|виконав|повернул|повернув)|(?:дію|запит|заявку|скасування|повернення(?:\s+коштів)?)\s+(?:вже\s+|успішно\s+)?(?:виконано|оформлено|скасовано|підтверджено|завершено)|кошти.{0,30}(?:повернено|повернули|відправлено)|вже на вашій картці|гроші\s+повернуто|скасува(?:в|ла|ли)\s+(?:вашу\s+)?підписку|підписк[уа]\s+скасовано)/i;
const STATE_CLAIMS: { claim: RegExp; evidence: RegExp }[] = [
  { claim: /\border\b.{0,60}\bcancell?ed\b|замовлення.{0,60}(?:скасован|відмінен)/i, evidence: /cancel|скасов|відмін/i },
  { claim: /\b(?:order|payment|charge)\b.{0,60}\brefunded\b|(?:кошти|гроші|платіж|оплат[уа]).{0,60}(?:повернено|повернуто)/i, evidence: /refund|поверн/i },
];
export function ungroundedClaim(reply: string, evidence: readonly string[]): boolean {
  if (ACTION_CLAIM.test(reply)) return true;
  return STATE_CLAIMS.some(({ claim, evidence: shows }) => claim.test(reply) && !evidence.some(value => shows.test(value)));
}

export class SupportHarness {
  constructor(private readonly deps: HarnessDeps) {}

  private async visibleMessages(businessId: string, caseId: string): Promise<Message[]> {
    const messages = await this.deps.store.messages(caseId);
    const sources = await this.deps.store.knowledge(businessId);
    const supportCase = await this.deps.store.getCase(caseId);
    const customer = supportCase ? await this.deps.store.customer(supportCase.customerId) : null;
    const external = this.deps.externalKnowledge ?? knowledgeRuntime.external;
    const validationSignal = AbortSignal.timeout(Math.min(this.deps.timeoutMs, 5000));
    const checks = new Map<string, Promise<boolean>>();
    const visible: Message[] = [];
    for (const [index, message] of messages.entries()) {
      let current = !message.sourceRefs?.some(ref => !sources.some(source => source.id === ref.id && source.version === ref.version && source.status === 'published' && (source.audience ?? 'customer') === 'customer' && (!source.plans?.length || (customer && source.plans.includes(customer.plan)))));
      if (message.externalSourceRefs?.length) {
        // Bound remote work for long transcripts; older external responses are retained in
        // storage for audit but are not displayed as currently verified customer guidance.
        current = current && !validationSignal.aborted && index >= messages.length - 100 && !!customer && !!external?.hasBusiness(businessId) && message.externalSourceRefs.length <= 50;
        if (current) {
          const key = JSON.stringify(message.externalSourceRefs);
          if (!checks.has(key)) checks.set(key, external!.validate({ businessId, plan: customer!.plan }, message.externalSourceRefs, validationSignal).catch(() => false));
          current = await checks.get(key)!;
        }
      }
      visible.push(current ? message : { ...message, body: '[Відповідь приховано: джерело змінено, відкликано або недоступне]', sourceRefs: [], externalSourceRefs: [] });
    }
    return visible;
  }

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
    const job = await this.deps.store.activeTurnJob(caseId);
    return { customer, supportCase: found, messages: await this.visibleMessages(customer.businessId, caseId), activeRun: job ? { id: job.id, status: job.status } : null };
  }

  async enqueueTurn(sessionToken: string | undefined, caseId: string, body: string, clientMessageId?: string) {
    const { customer } = await this.customerCase(sessionToken, caseId);
    body = body.trim();
    if (!body || body.length > 2000) throw new HarnessError(422, 'Message must contain 1–2000 non-blank characters');
    return this.deps.store.enqueueTurn(caseId, customer.id, body, clientMessageId);
  }

  async runQueued(job: SupportTurnJob, lease: TurnLease) {
    const customer = await this.deps.store.customer(job.customerId);
    if (!customer) throw new HarnessError(404, 'Customer not found');
    return this.runTurn(customer.sessionToken, job.caseId, job.body, lease);
  }

  /** One customer message -> one bounded agent run -> at most one proposal. */
  async runTurn(sessionToken: string | undefined, caseId: string, body: string, preparedLease?: TurnLease): Promise<TurnResult> {
    const { store } = this.deps;
    const { customer, supportCase } = await this.customerCase(sessionToken, caseId);
    body = body.trim();
    if (!body || body.length > 2000) throw new HarnessError(422, 'Message must contain 1–2000 non-blank characters');
    if (supportCase.ownership === 'staff') {
      if (preparedLease) throw new HarnessError(409, 'Conversation is owned by staff');
      await store.addMessage(caseId, 'customer', body);
      await store.audit(caseId, 'message.routed_to_staff', `customer:${customer.id}`);
      return { case: supportCase, reply: null, proposal: null };
    }
    const lease = preparedLease ?? await store.acquireTurn(caseId, randomUUID());
    if (!lease) throw new HarnessError(409, 'A run is active or the conversation is owned by staff');
    try {
    const business = (await store.business(customer.businessId))!;
    const settings = await store.settings(customer.businessId);
    if (!preparedLease) {
      await store.addMessage(caseId, 'customer', body);
      await store.audit(caseId, 'message.received', `customer:${customer.id}`, { length: body.length });
    }

    const external = this.deps.externalKnowledge ?? knowledgeRuntime.external;
    const externalMode = external?.hasBusiness(customer.businessId) ?? false;
    const externalSignal = AbortSignal.timeout(this.deps.timeoutMs);
    const knowledge = externalMode ? [] : (await store.knowledge(customer.businessId)).filter(d => d.status === 'published' && (d.audience ?? 'customer') === 'customer' && (!d.plans?.length || d.plans.includes(customer.plan))).map(({ id, businessId, title, category, content, version, audience, plans, sourceUrl }) => ({ id, businessId, title, category, content, version, audience, plans, sourceUrl }));
    const skills = (await store.skills(customer.businessId)).filter(s => s.enabled).map(({ id, name, content, revision }) => ({ id, name, content, revision }));
    // A native session or product history can reuse facts without searching this turn.
    // Conservatively fence every eligible source until transitive citation tracking exists.
    const sourceRefs = knowledge.map(({ id, version }) => ({ id, version }));
    const history = (await this.visibleMessages(customer.businessId, caseId)).slice(-10).map(message => externalMode && message.sourceRefs?.length
      ? { ...message, body: '[Попередню відповідь із локальної бази знань не включено: джерело бізнесу змінено]', sourceRefs: [], externalSourceRefs: [] }
      : message);
    const externalRefs = new Map<string, ExternalKnowledgeRef>();
    const remember = (refs: ExternalKnowledgeRef[]) => {
      for (const ref of refs) {
        const key = JSON.stringify([ref.connectorId, ref.pointId]);
        const prior = externalRefs.get(key);
        if (prior && prior.contentHash !== ref.contentHash) throw new StaleTurn('External knowledge changed during this turn');
        externalRefs.set(key, ref);
      }
      if (externalRefs.size > 50) throw new StaleTurn('Too many external sources; narrow the question');
    };
    if (externalMode) for (const message of history) remember(message.externalSourceRefs ?? []);
    let externalFailed = false;
    const assertExternal = async () => {
      if (!externalMode) return;
      if (externalFailed || externalSignal.aborted || !await external!.validate({ businessId: customer.businessId, plan: customer.plan }, [...externalRefs.values()], externalSignal).catch(() => false)) throw new StaleTurn('External knowledge changed or is unavailable');
    };
    const observedPolicies=new Map<string,{manifestHash:string;connectionRevision:string;policyRevision:number}>();
    const assertActive = async () => {
      if (!await store.assertTurn(lease)) throw new StaleTurn('Conversation ownership changed');
      if (externalMode) {
        const currentCustomer = await store.customer(customer.id);
        if (!currentCustomer || currentCustomer.businessId !== customer.businessId || currentCustomer.plan !== customer.plan) throw new StaleTurn('External knowledge scope changed');
      }
      const current = await store.knowledge(customer.businessId);
      if (knowledge.some(d => !current.some(n => n.id === d.id && n.version === d.version && n.status === 'published'))) throw new StaleTurn('Knowledge access changed');
      const currentSkills = await store.skills(customer.businessId);
      if (skills.some(s => !currentSkills.some(n => n.id === s.id && n.revision === s.revision && n.enabled))) throw new StaleTurn('Skill access changed');
      if (JSON.stringify((await store.business(customer.businessId))?.policy) !== JSON.stringify(business.policy)) throw new StaleTurn('Business policy changed');
      if (!sameClassificationConfig((await store.settings(customer.businessId)).classification, settings.classification)) throw new StaleTurn('Classification taxonomy changed');
      if (externalFailed) throw new StaleTurn('External knowledge is unavailable');
      for(const [integrationId,observed] of observedPolicies) { const state=await store.integrationStore.get(customer.businessId,integrationId);if(!state||!state.enabled||state.draining||state.activeManifestHash!==observed.manifestHash||state.connectionRevision!==observed.connectionRevision||state.policy.policyRevision!==observed.policyRevision) throw new StaleTurn('Integration policy changed'); }
    };
    const ctx: AgentContext = {
      conversationId: caseId, runId: lease.runId, businessId: customer.businessId, ownershipVersion: lease.ownershipVersion,
      runtimeAttempt: lease.jobFence !== undefined && lease.jobFence > 1 ? lease.jobFence : undefined,
      ...(externalMode ? { knowledgeSessionKey: lease.runId } : {}),
      turnJobId: lease.jobFence !== undefined ? lease.runId : undefined,
      assertActive, knowledge, skills, classification: settings.classification,
      searchKnowledge: async (query, signal) => {
        await assertActive();
        if (externalMode) {
          try {
            const result = await external!.search({ businessId: customer.businessId, plan: customer.plan }, query, signal ? AbortSignal.any([signal, externalSignal]) : externalSignal);
            remember(result.refs);
            await assertActive();
            await store.audit(caseId, 'knowledge.searched', `agent:${lease.runId}`, { source: 'external', queryLength: query.length, hits: result.hits.map(hit => ({ id: hit.id, version: hit.version, section: hit.section })) });
            return result.hits;
          } catch (error) { externalFailed = true; throw error; }
        }
        const hits = await (this.deps.knowledge ?? knowledgeRuntime.retriever).search(knowledge, query, { audience: 'customer', plan: customer.plan });
        await store.audit(caseId, 'knowledge.searched', `agent:${lease.runId}`, { queryLength: query.length, hits: hits.map(h => ({ id: h.id, version: h.version, section: h.section, score: h.score })) });
        return hits.map(({ id, title, content, version, section }) => ({ id, title, content, version, section }));
      },
      customer: { name: customer.name, plan: customer.plan },
      business: { name: business.name, currency: business.currency, policy: business.policy, responseStyle: { language: settings.language, tone: settings.tone } },
      payments: await store.payments(customer.id, 10),
      history: history.map(m => ({ role: m.role, body: m.body })),
      message: body,
      allowedTools: business.policy.enabledTools,
    };
    // At most one external action per durable turn: the (turn_job_id, tool) logical key holds it across retries.
    let externalAction: { proposal: Proposal; title: string } | undefined;
    // Parallel tool calls must not race past the check below: proposals in one turn run strictly in order.
    let proposing: Promise<unknown> = Promise.resolve();
    const propose = (request: ExternalActionRequest): Promise<BusinessToolResult> => {
      const run = proposing.then(() => proposeNow(request));
      proposing = run.catch(() => undefined);
      return run;
    };
    const proposeNow = async ({ args: requestedArgs, mode, title }: ExternalActionRequest): Promise<BusinessToolResult> => {
      await assertActive();
      const prior = externalAction?.proposal ?? (lease.jobFence !== undefined ? (await store.proposals(caseId)).find(p => p.tool === 'external_action' && p.turnJobId === lease.runId) : undefined);
      const semantic = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([key])=>key!=='expiresAt'));
      if (prior && argsHash(caseId,'external_action',semantic(prior.args)) !== argsHash(caseId,'external_action',semantic(requestedArgs))) return { status: 'denied', reasonCode: 'one_external_action_per_turn' };
      const args = prior?.args ?? requestedArgs;
      const hash = argsHash(caseId, 'external_action', args);
      let proposal = prior ?? await store.createProposal({ caseId, tool: 'external_action', args, argsHash: hash, risk: 'high', status: 'pending',
        policy: { allowed: true, requiresApproval: mode === 'ask', checks: [{ name: 'integration_permission', passed: true, detail: `${mode}: ${String(args.operationKey)} (policy r${String(args.policyRevision)})` }] } }, lease);
      if (!prior) await store.audit(caseId, 'action.proposed', 'agent', { proposalId: proposal.id, tool: 'external_action', operationKey: args.operationKey, mode });
      if (mode === 'auto' && proposal.status === 'pending') {
        const claimed = await store.claimProposal(proposal.id, proposal.argsHash, 'executing', 'agent:auto');
        if (claimed) proposal = (await this.executeExternal(claimed, assertActive)).proposal;
      }
      externalAction = { proposal, title };
      return toolResult(proposal, title);
    };
    const integrations = this.deps.integrations?.forContext({ businessId: customer.businessId, customerId: customer.id, caseId, ownershipVersion: supportCase.ownershipVersion, assertActive, propose,
      rememberPolicy:(integrationId,manifestHash,connectionRevision,policyRevision)=>observedPolicies.set(integrationId,{manifestHash,connectionRevision,policyRevision}),
    });
    ctx.businessTools = integrations?.listTools ? await integrations.listTools() : integrations?.tools ?? [];
    // Business data actually returned this turn: the only ground for the reply to state an order/payment status.
    const evidence: string[] = [];
    ctx.callBusinessTool = integrations ? async (integrationId, name, input, signal) => {
      const result = await integrations.callTool(integrationId, name, input, signal);
      collectStrings(result, evidence);
      return result;
    } : undefined;

    const { decision, source, model, classification } = await this.decide(caseId, ctx);
    await assertActive();
    await assertExternal();
    const sentiment = mergeSentiment(lexicalSentiment(body), decision.sentiment);
    const analysis: Analysis = {
      intent: decision.intent, summary: decision.summary, reasoning: decision.reasoning, sentiment,
      priority: priorityFor(sentiment, decision.intent), tone: toneFor(sentiment) === 'de-escalating' ? 'de-escalating' : settings.tone, source, model,
      classification,
    };
    await store.audit(caseId, 'agent.analyzed', `agent:${model}`, { intent: analysis.intent, sentiment: sentiment.label, priority: analysis.priority, source, classification: analysis.classification });

    let action = decision.action;
    if(externalAction?.proposal.args.effect==='write') action=null;
    if (!action && (sentiment.abusive || sentiment.escalationRisk >= 0.8)) {
      action = { tool: 'escalate_to_human', args: { reason: `High escalation risk (${sentiment.label})` } };
    }
    let proposal: Proposal | null = null;
    if (action) proposal = await this.propose(caseId, customer, action.tool, action.args, lease);
    let escalated = proposal?.status === 'executed' && proposal.tool === 'escalate_to_human';
    if (externalAction) externalAction.proposal = (await store.proposal(externalAction.proposal.id)) ?? externalAction.proposal;
    // An unconfirmed external effect needs a person to reconcile it before anything else happens.
    if (externalAction && ['unknown','failed','expired','invalidated'].includes(externalAction.proposal.status)) escalated = true;
    if (proposal?.status === 'denied' && proposal.tool !== 'escalate_to_human') {
      const handoff = await this.propose(caseId, customer, 'escalate_to_human', { reason: `Policy denied ${proposal.tool}` }, lease);
      escalated = handoff.status === 'executed';
    }

    const waiting = (await store.proposals(caseId)).some(p => ['pending', 'approved', 'executing'].includes(p.status));
    const status = escalated ? 'escalated' : waiting ? 'awaiting_approval' : 'open';
    await assertActive();
    await assertExternal();
    const completed = await store.completeTurn(lease, { status, intent: analysis.intent, analysis, priority: analysis.priority, ...(escalated ? { ownership: 'staff' as const } : {}) }, this.compose(decision, analysis, proposal, business.currency, body, externalAction, evidence), sourceRefs, {policy:business.policy,skills:skills.map(({id,revision})=>({id,revision})),classification:settings.classification,externalSourceRefs:[...externalRefs.values()],completionActionId:externalAction?.proposal.id,integrationRefs:[...observedPolicies].map(([integrationId,ref])=>({integrationId,...ref}))});
    if (!completed) throw new StaleTurn('Conversation ownership changed');
    return { ...completed, proposal };
    } catch (error) {
      if (error instanceof StaleTurn) throw new HarnessError(409, error.message);
      throw error;
    } finally { await store.releaseTurn(lease); }
  }

  private async decide(caseId: string, ctx: AgentContext): Promise<{ decision: AgentDecision; source: Analysis['source']; model: string; classification: TicketClassification | null }> {
    const { model, fallback, store, timeoutMs, classifier } = this.deps;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // A dedicated Decisions provider classifies independently of the conversational/tool model.
    // Both requests share one overall deadline. Failure never silently substitutes Gemini labels.
    const external = classifier && ctx.classification ? (async () => {
      const provenance = { provider: classifier.provider, model: classifier.model, ...(classifier.scoreKind ? { scoreKind: classifier.scoreKind } : {}) };
      let aborted!: () => void;
      try {
        controller.signal.throwIfAborted();
        const input = await Promise.race([
          classifier.classify({ businessId: ctx.businessId, taxonomy: ctx.classification!, history: ctx.history.slice(-10), message: ctx.message }, controller.signal),
          new Promise<never>((_, reject) => { aborted = () => reject(new Error('Classification deadline or ownership changed')); controller.signal.addEventListener('abort', aborted, { once: true }); }),
        ]);
        return normalizeClassification(ctx.classification, input, 'llm', provenance);
      } catch {
        return normalizeClassification(ctx.classification, undefined, 'fallback', provenance);
      } finally { if (aborted) controller.signal.removeEventListener('abort', aborted); }
    })() : undefined;
    let checkingOwnership = false;
    const classifierWatch = external ? setInterval(() => {
      if (checkingOwnership || controller.signal.aborted) return;
      checkingOwnership = true;
      void ctx.assertActive().catch(error => controller.abort(error)).finally(() => { checkingOwnership = false; });
    }, 500) : undefined;
    const classified = async (decision: AgentDecision, source: Analysis['source']) => external ? external : normalizeClassification(ctx.classification, decision.classification, source);
    try {
      const pending = model.decide(external ? { ...ctx, classification: null } : ctx, controller.signal);
      // DSH settles only after its child and scoped gateway have closed. Keep the turn claim until then.
      const output = model.provider.startsWith('dsh:') ? await pending : await Promise.race([
        pending,
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error(`LLM timeout after ${timeoutMs} ms`)))),
      ]);
      const decision = decisionSchema.parse(output.decision);
      const classification = await classified(decision, model.provider === 'rules' ? 'fallback' : 'llm');
      await ctx.assertActive();
      await store.recordRun({ caseId, turnJobId: ctx.turnJobId ?? null, provider: model.provider, model: model.model, status: 'ok', steps: output.steps, toolCalls: output.toolCalls, latencyMs: Date.now() - started, error: null });
      return { decision, source: model.provider === 'rules' ? 'fallback' : 'llm', model: model.model, classification };
    } catch (error) {
      await ctx.assertActive();
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Model failed';
      const output = await fallback.decide(ctx, new AbortController().signal);
      const classification = await classified(output.decision, 'fallback');
      await ctx.assertActive();
      await store.recordRun({ caseId, turnJobId: ctx.turnJobId ?? null, provider: model.provider, model: model.model, status: 'fallback', steps: output.steps, toolCalls: output.toolCalls, latencyMs: Date.now() - started, error: message });
      await store.audit(caseId, 'agent.fallback', 'system', { error: message });
      return { decision: output.decision, source: 'fallback', model: fallback.model, classification };
    } finally { clearTimeout(timer); if (classifierWatch) clearInterval(classifierWatch); }
  }

  private async policyContext(customer: Customer): Promise<PolicyContext> {
    const { store } = this.deps;
    // Customer-wide: a second case must not open a parallel proposal for the same payment.
    // ponytail: scans all cases; add a store query by customerId if case volume grows.
    const cases = (await store.listCases()).filter(c => c.customerId === customer.id);
    const proposals = (await Promise.all(cases.map(c => store.proposals(c.id)))).flat();
    return {
      business: (await store.business(customer.businessId))!,
      customer,
      payments: await store.payments(customer.id, 50),
      refunds: await store.refunds(customer.id),
      openProposals: proposals.filter(p => ['pending', 'approved', 'executing', 'unknown'].includes(p.status)),
    };
  }

  private async propose(caseId: string, customer: Customer, tool: string, args: Record<string, unknown>, lease: TurnLease): Promise<Proposal> {
    const { store } = this.deps;
    const policy = evaluatePolicy(tool, args, await this.policyContext(customer));
    const proposal = await store.createProposal({
      caseId, tool, args, argsHash: argsHash(caseId, tool, args),
      risk: isToolName(tool) ? TOOLS[tool].risk : 'high',
      status: policy.allowed ? 'pending' : 'denied', policy,
    }, lease);
    await store.audit(caseId, policy.allowed ? 'action.proposed' : 'action.denied', 'agent', { proposalId: proposal.id, tool, failed: policy.checks.filter(c => !c.passed).map(c => c.name) });
    if (policy.allowed && !policy.requiresApproval) {
      const claimed = await store.claimProposal(proposal.id, proposal.argsHash, 'executing', 'agent:auto');
      if (claimed) return store.finishProposal(claimed.id, 'executed', { queue: 'tier-2' }, null);
    }
    return proposal;
  }

  async approve(proposalId: string, operator: string, hash: string) {
    const { store } = this.deps;
    const existing = await store.proposal(proposalId);
    if (!existing) throw new HarnessError(404, 'Proposal not found');
    const claimed = await store.decideProposal(proposalId, hash, 'approved', `operator:${operator}`);
    if (!claimed) {
      throw new HarnessError(409, existing.argsHash !== hash ? 'Approval does not match the proposed operation' : `Proposal is already ${existing.status}`);
    }
    await store.audit(claimed.caseId, 'action.approved', `operator:${operator}`, { proposalId, argsHash: hash });
    return { proposal: claimed, case: (await store.getCase(claimed.caseId))! };
  }

  async executeApproved(proposalId: string, operator: string, hash: string) {
    const existing = await this.deps.store.proposal(proposalId);
    if (!existing) throw new HarnessError(404, 'Proposal not found');
    const claimed = await this.deps.store.claimExecution(proposalId, hash, `operator:${operator}`);
    if (!claimed) throw new HarnessError(409, 'Operation is not approved, arguments changed, or this payment has already been claimed');
    return this.execute(claimed);
  }

  async reject(proposalId: string, operator: string, reason: string) {
    const { store } = this.deps;
    const existing = await store.proposal(proposalId);
    if (!existing) throw new HarnessError(404, 'Proposal not found');
    const claimed = await store.claimProposal(proposalId, existing.argsHash, 'rejected', `operator:${operator}`);
    if (!claimed) throw new HarnessError(409, `Proposal is already ${existing.status}`);
    await store.audit(claimed.caseId, 'action.rejected', `operator:${operator}`, { proposalId, reason });
    await store.addMessage(claimed.caseId, 'assistant', claimed.tool === 'external_action'
      ? `Спеціаліст не погодив дію «${String(claimed.args.title)}». Він зв'яжеться з вами щодо наступних кроків.`
      : 'A support specialist reviewed the request and did not approve an automatic refund. They will contact you with next steps.');
    await store.setOwnership(claimed.caseId, 'staff', `operator:${operator}`);
    const supportCase = await store.updateCase(claimed.caseId, { status: 'escalated' });
    return { proposal: claimed, case: supportCase };
  }

  /** Executes a claimed (status=executing) proposal. Re-validates policy against current state first. */
  private async execute(proposal: Proposal) {
    if (proposal.tool === 'external_action') return this.executeExternal(proposal);
    const { store, provider } = this.deps;
    const supportCase = (await store.getCase(proposal.caseId))!;
    const customer = (await store.customer(supportCase.customerId))!;
    const ctx = await this.policyContext(customer);
    // claimExecution already reserves this payment atomically. Concurrently created
    // pending/approved proposals cannot execute; allowing them to veto the owner
    // would deadlock both approved requests without performing the authorised refund.
    ctx.openProposals = ctx.openProposals.filter(p => p.id !== proposal.id && ['executing', 'unknown'].includes(p.status));
    const policy = evaluatePolicy(proposal.tool, proposal.args, ctx);
    const finish = async (status: 'executed' | 'failed' | 'unknown', result: Record<string, unknown> | null, error: string | null, caseStatus: SupportCase['status'], message: string | null) => {
      const done = await store.finishProposal(proposal.id, status, result, error);
      await store.audit(proposal.caseId, status === 'executed' ? 'action.executed' : 'action.failed', proposal.decidedBy ?? 'system', { proposalId: proposal.id, tool: proposal.tool, result, error });
      if (message) await store.addMessage(proposal.caseId, 'assistant', message);
      if (caseStatus === 'escalated') await store.setOwnership(proposal.caseId, 'staff', proposal.decidedBy ?? 'queue:tier-2');
      return { proposal: done, case: await store.updateCase(proposal.caseId, { status: caseStatus }) };
    };
    if (!policy.allowed) {
      const failed = policy.checks.filter(c => !c.passed).map(c => c.detail).join('; ');
      return finish('failed', null, `Policy re-check failed: ${failed}`, 'escalated', 'We could not complete this action automatically. A specialist will follow up with you.');
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
        `Симульоване повернення ${money(row.amountCents, payment.currency)} за дубль ${payment.merchantRef} виконано в демо (номер ${row.providerRef}). Реальні кошти не переміщувалися.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Provider error';
      return error instanceof ProviderError
        ? finish('failed', null, message, 'escalated', 'Провайдер відхилив дію. No refund has been made. Звернення передано спеціалісту.')
        : finish('unknown', null, message, 'escalated', 'Результат дії не підтверджено. Повторне виконання заблоковано до перевірки спеціалістом.');
    }
  }

  /** Dispatches a claimed external action once; the outcome is recorded before anyone is told about it. */
  private async executeExternal(proposal: Proposal, assertActive: () => Promise<void> = async () => undefined) {
    const { store } = this.deps;
    const supportCase = (await store.getCase(proposal.caseId))!;
    const customer = (await store.customer(supportCase.customerId))!;
    let scoped: ReturnType<BusinessIntegrations['forContext']> | undefined;
    try {
      // In a turn, the turn's ownership fence runs right before dispatch; a takeover stops the write.
      scoped = this.deps.integrations?.forContext({ businessId: customer.businessId, customerId: customer.id, caseId: supportCase.id, ownershipVersion: supportCase.ownershipVersion,
        assertActive: async()=>{ await assertActive(); const current=await store.getCase(proposal.caseId); if(!current || current.ownership!=='bot' || current.ownershipVersion!==proposal.args.ownershipVersion) throw new StaleTurn('Conversation ownership changed'); },
        markDispatched:async()=>{ if(!await store.markExternalDispatched(proposal.id)) throw new StaleTurn('Execution already dispatched'); },
      });
    } catch { scoped = undefined; }
    const outcome: ActionOutcome = scoped?.executeAction
      // An executor crash after a possible dispatch must not look like a clean failure.
      ? await scoped.executeAction(proposal.args, proposal.id).catch(() => ({ status: 'unknown' as const, reasonCode: 'executor_error' }))
      : { status: 'failed', reasonCode: 'integration_unavailable' };
    const result=outcome.status==='executed'?{data:outcome.data,...(outcome.guard?{guard:outcome.guard}:{})}:outcome.guard?{guard:outcome.guard}:null;
    const error=outcome.status==='executed'?null:outcome.reasonCode;
    const done=await store.finishExternalAction(proposal.id,outcome.status,result,error,externalMessage({...proposal,status:outcome.status,result,error},true),proposal.decidedBy??'system');
    return {proposal:done,case:(await store.getCase(proposal.caseId))!};
  }

  private compose(decision: AgentDecision, analysis: Analysis, proposal: Proposal | null, currency: string, body: string, external?: { proposal: Proposal }, evidence: readonly string[] = []): string {
    const uk = /[а-яіїєґ]/i.test(body);
    const lead = analysis.tone === 'neutral' ? '' : uk ? 'Мені дуже шкода, що так сталося — розумію, як це неприємно. ' : "I'm really sorry about this — I understand how frustrating it is. ";
    // External outcomes come only from the recorded proposal state, never from model prose.
    if (external) return lead + externalMessage(external.proposal, uk);
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
    // Financial outcomes come only from verified execution, never generated prose.
    if (!proposal && ['duplicate_charge', 'refund_request'].includes(decision.intent)) {
      return lead + (uk ? 'Я не можу підтвердити автоматичне повернення. Підкажіть дату та суму списання — за потреби підключимо спеціаліста.' : "I cannot confirm an automatic refund. Please tell me the date and amount of the charge so a specialist can review it.");
    }
    if (!proposal && decision.intent === 'cancel_subscription') {
      return lead + (uk ? 'Я не можу скасувати підписку автоматично. Спеціаліст розгляне ваш запит і відповість тут.' : 'I cannot cancel the subscription automatically. A specialist will review your request and reply here.');
    }
    if (!proposal && decision.intent === 'billing_question') {
      return lead + (uk ? 'Дякую за питання щодо оплати. Підкажіть дату та суму списання — я перевірю, а за потреби підключу спеціаліста.' : 'Thanks for your billing question. Please tell me the date and amount of the charge so I can check it; a specialist will join if needed.');
    }
    if (!decision.reply || ungroundedClaim(decision.reply, evidence)) {
      return lead + (uk ? 'Дякую! Я перевіряю ваше звернення, спеціаліст підключиться за потреби.' : "Thanks! I'm looking into this and a specialist will join if needed.");
    }
    return decision.reply;
  }

  async detail(caseId: string): Promise<CaseDetail> {
    const { store } = this.deps;
    await store.recoverInterruptedExecutions();
    const supportCase = await store.getCase(caseId);
    if (!supportCase) throw new HarnessError(404, 'Case not found');
    const customer: Partial<Customer> & Omit<Customer, 'sessionToken'> = { ...(await store.customer(supportCase.customerId))! };
    delete customer.sessionToken;
    const activeRun = await store.activeTurnJob(caseId);
    return {
      activeRun: activeRun ? { id: activeRun.id, status: activeRun.status } : null,
      case: supportCase, customer,
      payments: await store.payments(customer.id, 20),
      messages: await this.visibleMessages(supportCase.businessId, caseId),
      proposals: await store.proposals(caseId),
      audit: await store.auditEvents(caseId),
      runs: await store.runs(caseId),
      refunds: await store.refunds(customer.id),
    };
  }
}

function toolResult(proposal: Proposal, title: string): BusinessToolResult {
  switch (proposal.status) {
    case 'pending': case 'approved': return { status: 'awaiting_approval', proposalId: proposal.id, summary: title };
    case 'executed': return { status: 'executed', actionId: proposal.id, data: proposal.result?.data ?? null };
    case 'executing': case 'unknown': return { status: 'unknown', actionId: proposal.id, reasonCode: proposal.error ?? 'in_progress' };
    default: return { status: 'failed', actionId: proposal.id, reasonCode: proposal.error ?? proposal.status };
  }
}

function externalMessage(proposal: Proposal, uk: boolean): string {
  const title = String(proposal.args.title ?? '');
  const data = proposal.result?.data as Record<string, unknown> | undefined;
  const state = typeof data?.status === 'string' && /^[\p{L}\p{N} _-]{1,40}$/u.test(data.status) ? data.status : null;
  switch (proposal.status) {
    case 'pending': case 'approved':
      return uk ? `Я підготував запит «${title}». Його має підтвердити спеціаліст — я напишу тут, щойно буде результат.` : `I prepared the request "${title}". A specialist needs to confirm it; I'll update you here.`;
    case 'executed':
      return uk ? `Дію «${title}» виконано${state ? ` (статус: ${state})` : ''}.` : `"${title}" is done${state ? ` (status: ${state})` : ''}.`;
    case 'unknown': case 'executing':
      return uk ? `Результат дії «${title}» не підтверджено. Повторне виконання заблоковано до перевірки спеціалістом.` : `The result of "${title}" is not confirmed. A specialist will check it before anything is retried.`;
    default:
      return uk ? `Дію «${title}» не виконано.` : `"${title}" was not completed.`;
  }
}

function collectStrings(value: unknown, into: string[], depth = 0): void {
  if (into.length >= 200 || depth > 4) return;
  if (typeof value === 'string') into.push(value.slice(0, 200));
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into, depth + 1);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, into, depth + 1);
}
