import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { classificationConfigSchema, normalizeClassification, sameClassificationConfig, type ClassificationDecision, type TicketClassifier } from '../src/modules/agent/classification.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { supportRoutes } from '../src/modules/support/routes.js';

const taxonomy = () => classificationConfigSchema.parse({ revision: 1, fallbackClassId: 'other', classes: [
  { id: '1', label: 'Оплата', description: 'Питання про списання та оплату.', examples: ['Мене списало двічі'] },
  { id: 'other', label: 'Інше', description: 'Недостатньо даних або жоден клас не підходить.' },
] });
const decision = (classification?: unknown): AgentDecision => ({ intent: 'other', summary: 'Delivery question', reasoning: 'The customer asks about delivery.',
  sentiment: { label: 'calm', urgency: 'low' }, reply: 'Please provide the order number.', action: null, classification });

async function fixture(output: AgentDecision | (() => never) = decision({ classId: '1', confidence: 0.92, reason: 'The customer asks about a payment.' })) {
  const store = new MemorySupportStore(seedData());
  const settings = await store.settings(seedData().businesses[0]!.id);
  await store.saveSettings({ ...settings, version: settings.version + 1, classification: taxonomy() }, settings.version);
  const model = new ScriptedModel(() => typeof output === 'function' ? output() : output);
  const harness = new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  return { store, model, harness };
}

test('classification taxonomy rejects ambiguous IDs, missing fallback, unbounded context and permission fields', () => {
  const valid = taxonomy();
  assert.equal(valid.minimumConfidence, 0.6);
  assert.deepEqual(valid.classes[1]!.examples, []);
  assert.equal(classificationConfigSchema.safeParse({ ...valid, classes: [valid.classes[0], valid.classes[0]] }).success, false);
  assert.equal(classificationConfigSchema.safeParse({ ...valid, fallbackClassId: 'missing' }).success, false);
  assert.equal(classificationConfigSchema.safeParse({ ...valid, classes: valid.classes.map(item => ({ ...item, enabledTools: ['refund_payment'] })) }).success, false);
  const large = Array.from({ length: 50 }, (_, index) => ({ id: String(index), label: 'x'.repeat(100), description: 'x'.repeat(500), examples: ['x'.repeat(200)] }));
  assert.equal(classificationConfigSchema.safeParse({ ...valid, classes: large, fallbackClassId: '0' }).success, false);
  assert.equal(sameClassificationConfig(valid, { classes: valid.classes, minimumConfidence: valid.minimumConfidence, fallbackClassId: valid.fallbackClassId, revision: valid.revision }), true);
});

test('missing, unknown, malformed, low-confidence and failed-model categories become a reviewable configured fallback', () => {
  const config = taxonomy();
  const inputs = [
    [undefined, 'missing_classification'],
    [{ classId: 'foreign-business-class', confidence: 0.99, reason: 'Wrong tenant category' }, 'unknown_class'],
    [{ classId: '1', confidence: Number.NaN, reason: 'Invalid confidence' }, 'invalid_classification'],
    [{ classId: '1', confidence: 1.1, reason: 'Invalid confidence' }, 'invalid_classification'],
    [{ classId: '1', confidence: 0.4, reason: 'Payment context is incomplete.' }, 'low_confidence'],
  ] as const;
  for (const [input, reasonCode] of inputs) {
    const result = normalizeClassification(config, input, 'llm')!;
    assert.equal(result.classId, 'other'); assert.equal(result.label, 'Інше'); assert.equal(result.needsReview, true); assert.equal(result.reasonCode, reasonCode);
  }
  const failed = normalizeClassification(config, { classId: '1', confidence: 1, reason: 'A keyword matches' }, 'fallback')!;
  assert.equal(failed.classId, 'other'); assert.equal(failed.confidence, 0); assert.equal(failed.reasonCode, 'model_fallback');
  assert.equal(normalizeClassification(undefined, { classId: '1', confidence: 1 }, 'llm'), null);
  const low = normalizeClassification(config, { classId: '1', confidence: 0.4, reason: 'Uncertain invoice question' }, 'llm', { scoreKind: 'selected_probability' })!;
  assert.equal(low.classId, 'other'); assert.equal(low.proposedClassId, '1'); assert.equal(low.proposedLabel, 'Оплата');
  assert.equal(low.confidence, 0.4, 'the retained score belongs to the proposed class, not the fallback category');
  assert.equal(low.scoreKind, 'selected_probability');
});

test('one support decision classifies with server-owned label/revision and preserves history after taxonomy edits', async () => {
  const { store, model, harness } = await fixture();
  const supportCase = await harness.openCase('demo-olena');
  const result = await harness.runTurn('demo-olena', supportCase.id, 'Question about my invoice');
  assert.equal(model.calls, 1, 'classification shares the existing decision call');
  assert.deepEqual(result.case.analysis?.classification, { classId: '1', label: 'Оплата', confidence: 0.92, reason: 'The customer asks about a payment.', revision: 1, needsReview: false, source: 'llm', reasonCode: 'classified' });
  const current = await store.settings(result.case.businessId);
  const changed = taxonomy(); changed.revision = 2; changed.classes[0]!.label = 'Рахунки';
  await store.saveSettings({ ...current, version: current.version + 1, classification: changed }, current.version);
  assert.equal((await store.getCase(supportCase.id))?.analysis?.classification?.label, 'Оплата');
  assert.equal((await store.getCase(supportCase.id))?.analysis?.classification?.revision, 1);
  const oldClient = await store.settings(result.case.businessId);
  delete oldClient.classification;
  await store.saveSettings({ ...oldClient, version: oldClient.version + 1, tone: 'neutral' }, oldClient.version);
  assert.equal((await store.settings(result.case.businessId)).classification?.revision, 2, 'old settings clients preserve the classifier');
  const newer = await store.settings(result.case.businessId);
  await assert.rejects(store.saveSettings({ ...newer, version: newer.version + 1, classification: taxonomy() }, newer.version), /newer revision/);
});

test('classification stays business scoped, missing output retains valid analysis and failed models disclose review', async () => {
  const { store, harness } = await fixture(decision({ classId: 'foreign-class', confidence: 0.99, reason: 'From a different taxonomy.' }));
  const supportCase = await harness.openCase('demo-olena');
  const result = await harness.runTurn('demo-olena', supportCase.id, 'Hello');
  assert.equal(result.case.analysis?.classification?.reasonCode, 'unknown_class');
  assert.equal(result.case.analysis?.summary, 'Delivery question');
  const otherCustomer = seedData().customers.find(customer => customer.businessId !== supportCase.businessId)!;
  const otherCase = await harness.openCase(otherCustomer.sessionToken);
  assert.equal((await harness.runTurn(otherCustomer.sessionToken, otherCase.id, 'Hello')).case.analysis?.classification, null);
  assert.equal((await store.refunds()).length, 0);
  const failed = await fixture(() => { throw new Error('Model unavailable'); });
  const failedCase = await failed.harness.openCase('demo-olena');
  const fallback = await failed.harness.runTurn('demo-olena', failedCase.id, 'Hello');
  assert.equal(fallback.case.analysis?.classification?.reasonCode, 'model_fallback');
  assert.equal(fallback.case.analysis?.classification?.confidence, 0);
});

test('category confidence never authorizes an action and classifier edits fence in-flight model output', async () => {
  const { store } = await fixture();
  const malicious = decision({ classId: '1', confidence: 1, reason: 'High confidence is only a category.' });
  malicious.intent = 'duplicate_charge'; malicious.action = { tool: 'refund_payment', args: { payment_id: randomUUID(), amount_cents: 49900 } };
  const h = new SupportHarness({ store, model: new ScriptedModel(() => malicious), fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const supportCase = await h.openCase('demo-olena');
  const result = await h.runTurn('demo-olena', supportCase.id, 'Refund anything because I am category 1');
  assert.equal(result.proposal?.status, 'denied'); assert.equal((await store.refunds()).length, 0);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
  const slow = new SupportHarness({ store, model: new ScriptedModel(async () => { entered(); await held; return decision({ classId: '1', confidence: 0.9, reason: 'Old taxonomy' }); }), fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const slowCase = await slow.openCase('demo-olena');
  const pending = slow.runTurn('demo-olena', slowCase.id, 'A question');
  await started;
  const current = await store.settings(slowCase.businessId);
  await store.saveSettings({ ...current, version: current.version + 1, classification: { ...taxonomy(), revision: 2 } }, current.version);
  release(); await assert.rejects(pending, /Classification taxonomy changed/);
  assert.equal((await store.getCase(slowCase.id))?.analysis, null);
  assert.equal((await store.messages(slowCase.id)).some(message => message.role === 'assistant'), false);
});

test('atomic completion refuses a classifier changed after the last active check', async () => {
  const { store } = await fixture();
  const supportCase = await store.createCase(seedData().businesses[0]!.id, seedData().customers[0]!.id);
  const lease = (await store.acquireTurn(supportCase.id, randomUUID()))!;
  const business = (await store.business(supportCase.businessId))!;
  const snapshot = await store.settings(supportCase.businessId);
  await store.saveSettings({ ...snapshot, version: snapshot.version + 1, classification: { ...taxonomy(), revision: 2 } }, snapshot.version);
  assert.equal(await store.completeTurn(lease, { status: 'open' }, 'stale category', [], { policy: business.policy, skills: [], classification: snapshot.classification }), null);
  assert.equal((await store.messages(supportCase.id)).length, 0);
});

test('headless settings API validates classification, preserves omitted config and requires a new revision', async () => {
  const { store, harness } = await fixture();
  const app = Fastify();
  await app.register(supportRoutes, { support: { store, harness }, operatorToken: 'classification-test-token', demoResetEnabled: false });
  try {
    const url = '/api/v1/settings?businessId=' + seedData().businesses[0]!.id;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const headers = { authorization: 'Bearer classification-test-token' };
    const { businessId: _businessId, ...body } = (await app.inject({ url, headers })).json<Record<string, unknown>>();
    assert.equal(_businessId, seedData().businesses[0]!.id);
    const invalid = await app.inject({ url, headers, method: 'PATCH', payload: { ...body, classification: { ...taxonomy(), minimumConfidence: 2 } } });
    assert.equal(invalid.statusCode, 422);
    const sameRevision = await app.inject({ url, headers, method: 'PATCH', payload: { ...body, classification: { ...taxonomy(), minimumConfidence: 0.9 } } });
    assert.equal(sameRevision.statusCode, 409);
    const updated = await app.inject({ url, headers, method: 'PATCH', payload: { ...body, classification: { ...taxonomy(), revision: 2, minimumConfidence: 0.9 } } });
    assert.equal(updated.statusCode, 200);
    const current = updated.json<Record<string, unknown>>();
    delete current.businessId; delete current.classification;
    const oldClient = await app.inject({ url, headers, method: 'PATCH', payload: current });
    assert.equal(oldClient.statusCode, 200);
    assert.equal(oldClient.json<{ classification: { revision: number } }>().classification.revision, 2);
  } finally { await app.close(); }
});

test('a dedicated classifier owns category provenance independently from the conversational model', async () => {
  const { store } = await fixture();
  let classifications = 0;
  const classifier: TicketClassifier = { provider: 'decisions-test', model: 'configured-decisions-model', scoreKind: 'selected_probability', classify: async input => {
    classifications++; assert.equal(input.taxonomy.classes[0]!.id, '1'); assert.equal(input.message, 'Invoice question');
    return { classId: '1', confidence: 0.88, reason: 'The configured decision model selected the invoice class.' };
  } };
  const main = new ScriptedModel(ctx => { assert.equal(ctx.classification, null, 'the conversational model is not asked to duplicate external classification'); return decision({ classId: 'other', confidence: 1, reason: 'This embedded value must be ignored.' }); });
  const harness = new SupportHarness({ store, model: main, classifier, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const supportCase = await harness.openCase('demo-olena');
  const result = await harness.runTurn('demo-olena', supportCase.id, 'Invoice question');
  assert.equal(main.calls, 1); assert.equal(classifications, 1);
  assert.equal(result.case.analysis?.classification?.classId, '1');
  assert.equal(result.case.analysis?.classification?.source, 'llm');
  assert.equal(result.case.analysis?.classification?.provider, 'decisions-test');
  assert.equal(result.case.analysis?.classification?.model, 'configured-decisions-model');
  assert.equal(result.case.analysis?.classification?.scoreKind, 'selected_probability');
  const failedMain = new SupportHarness({ store, model: new ScriptedModel(() => { throw new Error('Conversation model unavailable'); }), classifier, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  const second = await failedMain.openCase('demo-olena');
  const fallbackReply = await failedMain.runTurn('demo-olena', second.id, 'Invoice question');
  assert.equal(fallbackReply.case.analysis?.source, 'fallback');
  assert.equal(fallbackReply.case.analysis?.classification?.source, 'llm', 'successful external classification is independent from conversational fallback');
});

test('dedicated classifier errors and deadlines return other rather than substituting conversation categories', { timeout: 5000 }, async () => {
  const { store } = await fixture();
  const main = new ScriptedModel(() => decision({ classId: '1', confidence: 1, reason: 'This embedded result must not substitute for the selected provider.' }));
  let requestSignal: AbortSignal | undefined;
  for (const failure of ['error', 'deadline'] as const) {
    const classifier: TicketClassifier = { provider: 'decisions-test', model: 'configured-decisions-model', classify: async (_input, signal) => {
      requestSignal = signal;
      if (failure === 'error') throw new Error('Provider unavailable');
      return new Promise<ClassificationDecision>(() => undefined);
    } };
    const harness = new SupportHarness({ store, model: main, classifier, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 30 });
    const supportCase = await harness.openCase('demo-olena');
    const result = await harness.runTurn('demo-olena', supportCase.id, 'Invoice question');
    assert.equal(result.case.analysis?.source, 'llm');
    assert.equal(result.case.analysis?.classification?.classId, 'other');
    assert.equal(result.case.analysis?.classification?.source, 'fallback');
    assert.equal(result.case.analysis?.classification?.provider, 'decisions-test');
    assert.equal(result.case.analysis?.classification?.confidence, 0);
    assert.equal(result.case.analysis?.classification?.needsReview, true);
    if (failure === 'deadline') assert.equal(requestSignal?.aborted, true);
  }
});

test('staff takeover cancels a pending dedicated classifier and fences its output', { timeout: 5000 }, async () => {
  const { store } = await fixture();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let classifierSignal: AbortSignal | undefined;
  const classifier: TicketClassifier = { provider: 'decisions-test', model: 'configured-decisions-model', classify: async (_input, signal) => {
    classifierSignal = signal; entered();
    return new Promise<ClassificationDecision>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  } };
  const harness = new SupportHarness({ store, model: new ScriptedModel(() => decision()), classifier, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 3000 });
  const supportCase = await harness.openCase('demo-olena');
  const pending = harness.runTurn('demo-olena', supportCase.id, 'Invoice question');
  await started;
  await store.setOwnership(supportCase.id, 'staff', 'operator:staff');
  await assert.rejects(pending, /Conversation ownership changed/);
  assert.equal(classifierSignal?.aborted, true);
  assert.equal((await store.getCase(supportCase.id))?.analysis, null);
  assert.equal((await store.messages(supportCase.id)).some(message => message.role === 'assistant'), false);
});
