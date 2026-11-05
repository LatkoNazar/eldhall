import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { classificationDecisionSchema } from '../src/modules/agent/classification.js';
import { RulesModel } from '../src/modules/agent/model.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';

const businessId = '20000000-0000-4000-8000-000000000001';
const foreignId = '20000000-0000-4000-8000-000000000002';
const taxonomy = () => ({
  businessId, revision: 1, fallbackClassId: 'other', minimumConfidence: 0.6,
  classes: [
    { id: '1', label: 'Оплата', description: 'Питання щодо рахунків та списань.', examples: ['Чому з мене списали двічі?'] },
    { id: 'other', label: 'Інше', description: 'Немає відповідного класу або бракує впевненості.', examples: [] },
  ],
});
const config = () => supportConfigSchema.parse({
  businesses: [{ id: businessId, slug: 'classification-store', name: 'Classification Store', currency: 'UAH', policy: { refundLimitCents: 50000, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment', 'escalate_to_human'] } }],
  classifications: [taxonomy()],
});

test('classification config validates business taxonomies and applies shared defaults', () => {
  assert.deepEqual(supportConfigSchema.parse({}).classifications, []);
  const entry = taxonomy();
  const parsed = supportConfigSchema.parse({ classifications: [{ businessId, revision: entry.revision, fallbackClassId: entry.fallbackClassId, classes: entry.classes.map(item => ({ id: item.id, label: item.label, description: item.description })) }] });
  assert.equal(parsed.classifications[0]?.minimumConfidence, 0.6);
  assert.deepEqual(parsed.classifications[0]?.classes[0]?.examples, []);
  for (const classification of [
    { ...taxonomy(), classes: [taxonomy().classes[0], taxonomy().classes[0]] },
    { ...taxonomy(), fallbackClassId: 'missing' },
    { ...taxonomy(), minimumConfidence: -0.1 },
    { ...taxonomy(), minimumConfidence: 1.1 },
    { ...taxonomy(), minimumConfidence: Number.NaN },
    { ...taxonomy(), revision: 0 },
    { ...taxonomy(), classes: [{ ...taxonomy().classes[0], id: 1 }, taxonomy().classes[1]] },
    { ...taxonomy(), classes: [{ ...taxonomy().classes[0], enabledTools: ['refund_payment'] }, taxonomy().classes[1]] },
  ]) assert.equal(supportConfigSchema.safeParse({ classifications: [classification] }).success, false);
  assert.equal(supportConfigSchema.safeParse({ classifications: [taxonomy(), taxonomy()] }).success, false);
});

test('taxonomy bootstrap is revisioned/idempotent and preserves operator settings and guards', async () => {
  const store = new MemorySupportStore();
  const first = config();
  await bootstrapSupportConfig(store, first);
  const before = await store.settings(businessId);
  assert.equal(before.classification?.classes[0]?.id, '1');
  await bootstrapSupportConfig(store, first);
  assert.deepEqual(await store.settings(businessId), before);
  const edited = await store.saveSettings({ ...before, language: 'uk', refundLimitCents: 100, version: before.version + 1 }, before.version);
  const next = config();
  next.classifications[0]!.revision = 2;
  next.classifications[0]!.classes[0]!.label = 'Рахунки';
  await bootstrapSupportConfig(store, next);
  const current = await store.settings(businessId);
  assert.equal(current.classification?.revision, 2);
  assert.equal(current.classification?.classes[0]?.label, 'Рахунки');
  assert.equal(current.language, 'uk');
  assert.equal(current.refundLimitCents, 100);
  assert.equal(current.requireApproval, true);
  assert.deepEqual(current.enabledTools, edited.enabledTools);
  assert.equal(current.version, edited.version + 1);
  await bootstrapSupportConfig(store, first);
  assert.deepEqual(await store.settings(businessId), current);
});

test('unknown business and same-revision taxonomy edits are rejected before bootstrap writes', async () => {
  const empty = new MemorySupportStore();
  const unknown = config();
  unknown.classifications[0]!.businessId = foreignId;
  await assert.rejects(bootstrapSupportConfig(empty, unknown), /unknown business/);
  assert.deepEqual(await empty.businessesList(), []);
  const store = new MemorySupportStore();
  await bootstrapSupportConfig(store, config());
  const invalid = config();
  invalid.classifications[0]!.classes[0]!.label = 'Змінений клас';
  invalid.knowledge.push({ id: '20000000-0000-4000-8000-000000000010', businessId, title: 'Must not be written', category: 'general', content: 'Synthetic test', version: 1, status: 'published', updatedAt: '2026-10-31T00:00:00.000Z' });
  await assert.rejects(bootstrapSupportConfig(store, invalid), /new revision/);
  assert.deepEqual(await store.knowledge(businessId), []);
  assert.equal((await store.settings(businessId)).classification?.classes[0]?.label, 'Оплата');
});

test('separate businesses keep separate classifier definitions', async () => {
  const store = new MemorySupportStore();
  const both = config();
  both.businesses.push({ ...both.businesses[0]!, id: foreignId, slug: 'foreign-classification-store' });
  both.classifications.push({ ...taxonomy(), businessId: foreignId, classes: [{ id: '1', label: 'Delivery', description: 'Shipping questions.', examples: [] }, taxonomy().classes[1]!] });
  await bootstrapSupportConfig(store, both);
  assert.equal((await store.settings(businessId)).classification?.classes[0]?.label, 'Оплата');
  assert.equal((await store.settings(foreignId)).classification?.classes[0]?.label, 'Delivery');
});

test('concurrent settings edits cause classifier bootstrap to conflict rather than overwrite guards', async () => {
  const store = new MemorySupportStore();
  await bootstrapSupportConfig(store, config());
  const save = store.saveSettings.bind(store);
  store.saveSettings = async (settings, expectedVersion) => {
    const latest = await store.settings(businessId);
    await save({ ...latest, refundLimitCents: 77, version: latest.version + 1 }, latest.version);
    return save(settings, expectedVersion);
  };
  const next = config(); next.classifications[0]!.revision = 2;
  await assert.rejects(bootstrapSupportConfig(store, next));
  const current = await store.settings(businessId);
  assert.equal(current.classification?.revision, 1);
  assert.equal(current.refundLimitCents, 77);
});

test('explicit classifier disable retains its revision across stale/equal bootstrap and ordinary turns', async () => {
  const store = new MemorySupportStore();
  const initial = config(); initial.classifications[0]!.revision = 5;
  await bootstrapSupportConfig(store, initial);
  const current = await store.settings(businessId);
  await store.saveSettings({ ...current, classification: null, version: current.version + 1 }, current.version);
  await bootstrapSupportConfig(store, config());
  const equal = config(); equal.classifications[0]!.revision = 5; equal.classifications[0]!.classes[0]!.label = 'An equal file must stay disabled';
  await bootstrapSupportConfig(store, equal);
  const disabled = await store.settings(businessId);
  assert.equal(disabled.classification, null);
  assert.deepEqual(await store.classificationState(businessId), { revision: 5, disabled: true });
  assert.equal(JSON.stringify(disabled).includes('disabled'), false);
  await assert.rejects(store.saveSettings({ ...disabled, classification: initial.classifications[0]!, version: disabled.version + 1 }, disabled.version), /newer revision/);
  await store.createCustomer({ id: foreignId, businessId, name: 'Synthetic Test Customer', email: 'disabled@example.test', plan: 'Test', sessionToken: 'synthetic-disabled-classifier' });
  const rules = new RulesModel();
  const harness = new SupportHarness({ store, provider: new SimulatedPaymentProvider(), model: rules, fallback: rules, timeoutMs: 1000 });
  const supportCase = await harness.openCase('synthetic-disabled-classifier');
  await harness.runTurn('synthetic-disabled-classifier', supportCase.id, 'Hello');
  assert.equal((await store.messages(supportCase.id)).filter(message => message.role === 'assistant').length, 1);
  assert.equal((await store.getCase(supportCase.id))?.analysis?.classification, null);
  const next = config(); next.classifications[0]!.revision = 6;
  await bootstrapSupportConfig(store, next);
  assert.equal((await store.settings(businessId)).classification?.revision, 6);
});

test('unrelated edits on a never-configured business do not prevent its first file taxonomy', async () => {
  const store = new MemorySupportStore();
  const initial = config(); initial.classifications = [];
  await bootstrapSupportConfig(store, initial);
  const current = await store.settings(businessId);
  await store.saveSettings({ ...current, tone: 'neutral', version: current.version + 1 }, current.version);
  await bootstrapSupportConfig(store, config());
  const configured = await store.settings(businessId);
  assert.equal(configured.classification?.revision, 1);
  assert.equal(configured.tone, 'neutral');
});

test('classification confidence and taxonomy reject non-finite values without relaxing boundary defaults', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.6', null, -0.01, 1.01]) {
    assert.equal(supportConfigSchema.safeParse({ classifications: [{ ...taxonomy(), minimumConfidence: value }] }).success, false);
    assert.equal(classificationDecisionSchema.safeParse({ classId: '1', confidence: value, reason: 'Synthetic evidence' }).success, false);
  }
  for (const confidence of [0, 1]) {
    assert.equal(classificationDecisionSchema.parse({ classId: '1', confidence, reason: 'Synthetic evidence' }).confidence, confidence);
    assert.equal(supportConfigSchema.parse({ classifications: [{ ...taxonomy(), minimumConfidence: confidence }] }).classifications[0]?.minimumConfidence, confidence);
  }
});
