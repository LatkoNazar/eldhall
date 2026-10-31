import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateFindings } from '../src/modules/insights/service.js';
import { emptySample, type InsightInput, type InsightOutput } from '../src/modules/insights/contracts.js';
import { DshInsightsModel } from '../src/runtime/insights-model.js';
import { DshSupportModel } from '../src/runtime/dsh-model.js';

function fixture() {
  const input: InsightInput = { tickets: [1, 2].map(() => ({ id: randomUUID(), messages: [{ id: randomUUID(), role: 'customer', body: 'Synthetic invoice download fails' }] })),
    knowledge: [{ id: randomUUID(), version: 2, title: 'Invoices', content: 'Contact support for billing documents.' }], sourceRefs: [], sample: emptySample() };
  const finding: InsightOutput['findings'][number] = { kind: 'recurring_issue', title: 'Invoice download reports', summary: 'Two sampled tickets report a download error; cause remains unverified.',
    recommendation: 'Ask staff to reproduce the issue.', evidence: input.tickets.map(ticket => ({ caseId: ticket.id, messageIds: [ticket.messages[0]!.id] })),
    knowledgeRefs: [{ id: input.knowledge[0]!.id, version: 2 }], proposedArticle: null };
  return { input, finding };
}
test('insights derive distinct case counts from real evidence instead of model totals', () => {
  const { input, finding } = fixture();
  const result = validateFindings(input, { findings: [{ ...finding, evidence: [...finding.evidence, finding.evidence[0]] }] });
  assert.equal(result[0]?.caseCount, 2);
  assert.equal(result[0]?.evidence.length, 2);
  assert.equal(result[0]?.draftId, null);
  assert.ok(result[0]?.id);
});
test('insights reject invented/cross-ticket evidence and unsupported recurrence/knowledge versions', () => {
  const { input, finding } = fixture();
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, evidence: [{ caseId: randomUUID(), messageIds: [input.tickets[0]!.messages[0]!.id] }] }] }), /outside/);
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, evidence: [{ caseId: input.tickets[0]!.id, messageIds: [input.tickets[1]!.messages[0]!.id] }] }] }), /outside/);
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, evidence: [finding.evidence[0], finding.evidence[0]] }] }), /distinct/);
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, knowledgeRefs: [{ id: input.knowledge[0]!.id, version: 1 }] }] }), /versions/);
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, kind: 'possible_contradiction', knowledgeRefs: [] }] }), /cite/);
});
test('insights reject hidden business actions, unbounded prose and unsupported fields', () => {
  const { input, finding } = fixture();
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, action: 'refund_payment' }] }));
  assert.throws(() => validateFindings(input, { findings: [{ ...finding, summary: 'x'.repeat(1201) }] }));
  assert.throws(() => validateFindings(input, { findings: Array.from({ length: 9 }, () => finding) }));
  assert.deepEqual(validateFindings(input, { findings: [] }), []);
});

test('insights preserves supported provider defaults and explicit local routing requirements', () => {
  for (const provider of ['google', 'openai', 'anthropic'] as const) {
    const insights = new DshInsightsModel({ provider });
    const support = new DshSupportModel({ provider });
    assert.equal(insights.model, support.model);
    assert.equal(insights.provider, support.provider);
  }
  assert.equal(new DshInsightsModel({ provider: 'openai', model: 'explicit-model' }).model, 'explicit-model');
  assert.throws(() => new DshInsightsModel({ provider: 'local', baseURL: 'http://127.0.0.1:1/v1' }), /explicit model/);
  assert.throws(() => new DshInsightsModel({ provider: 'local', model: 'local-model' }), /base URL/);
});
