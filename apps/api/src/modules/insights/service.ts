import { randomUUID } from 'node:crypto';
import { insightOutputSchema, InsightError, type InsightFinding, type InsightInput, type InsightModel } from './contracts.js';
import type { InsightsRepository } from './repository.js';

/** Only references actually present in this bounded, business-scoped input may support a finding. */
export function validateFindings(input: InsightInput, output: unknown): InsightFinding[] {
  return insightOutputSchema.parse(output).findings.map(finding => {
    const evidence = new Map<string, Set<string>>();
    for (const ref of finding.evidence) {
      const ticket = input.tickets.find(item => item.id === ref.caseId);
      if (!ticket || ref.messageIds.some(id => !ticket.messages.some(message => message.id === id))) throw new InsightError(422, 'Finding cites a ticket or message outside the selected input');
      const messages = evidence.get(ref.caseId) ?? new Set<string>();
      ref.messageIds.forEach(id => messages.add(id));
      evidence.set(ref.caseId, messages);
    }
    if (finding.kind === 'recurring_issue' && evidence.size < 2) throw new InsightError(422, 'A recurring issue requires at least two distinct sampled tickets');
    if (finding.kind === 'possible_contradiction' && !finding.knowledgeRefs.length) throw new InsightError(422, 'A possible contradiction must cite sampled published knowledge');
    if (finding.knowledgeRefs.some(ref => !input.knowledge.some(source => source.id === ref.id && source.version === ref.version))) throw new InsightError(422, 'Finding cites knowledge outside the selected source versions');
    return { ...finding, evidence: [...evidence].map(([caseId, messages]) => ({ caseId, messageIds: [...messages] })),
      id: randomUUID(), caseCount: evidence.size, draftId: null };
  });
}

export class InsightsService {
  constructor(readonly repository: InsightsRepository, readonly model: InsightModel | undefined, readonly timeoutMs: number,readonly workspaceBusinessId?:string) {}
  async create(businessId: string, limit: number, requestId?: string) {
    if(this.workspaceBusinessId&&businessId!==this.workspaceBusinessId)throw new InsightError(404,'Business not found');
    if (!this.model) throw new InsightError(503, 'AI Insights requires a configured DSH model');
    return this.repository.create(businessId, limit, requestId, this.model.provider, this.model.model);
  }
  async processOne(owner: string, parentSignal: AbortSignal): Promise<boolean> {
    if (!this.model || parentSignal.aborted) return false;
    const lease = await this.repository.claim(owner,this.workspaceBusinessId);
    if (!lease) return false;
    const controller = new AbortController();
    const cancel = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', cancel, { once: true });
    if (parentSignal.aborted) cancel();
    const deadline = setTimeout(() => controller.abort(new Error('Insights deadline exceeded')), this.timeoutMs);
    let heartbeat = false;
    const timer = setInterval(() => {
      if (heartbeat || controller.signal.aborted) return;
      heartbeat = true;
      void this.repository.renew(lease).then(ok => { if (!ok) controller.abort(new Error('Insights lease changed')); })
        .catch(() => controller.abort(new Error('Insights lease unavailable'))).finally(() => { heartbeat = false; });
    }, 8000);
    try {
      const input = await this.repository.snapshot(lease, { provider: this.model.provider, model: this.model.model });
      const assertActive = async () => { controller.signal.throwIfAborted(); if (!await this.repository.active(lease)) throw new InsightError(409, 'Insights lease changed'); controller.signal.throwIfAborted(); };
      await assertActive();
      const result = input.tickets.length ? await this.model.analyze(input, { businessId: lease.businessId, runId: `${lease.id}:${lease.fence}`, assertActive }, controller.signal) : { findings: [] };
      await assertActive();
      await this.repository.complete(lease, input, validateFindings(input, result));
    } catch {
      // Persist only an owned error; provider messages can contain credentials or conversation contents.
      if (parentSignal.aborted) await this.repository.requeue(lease);
      else await this.repository.fail(lease);
    } finally {
      clearTimeout(deadline);
      clearInterval(timer);
      parentSignal.removeEventListener('abort', cancel);
    }
    return true;
  }
}
