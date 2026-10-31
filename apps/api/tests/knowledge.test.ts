import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision, type AgentModel } from '../src/modules/agent/model.js';
import { KnowledgeRetriever, type KnowledgeDoc } from '../src/modules/knowledge/retriever.js';
import { parseFrontmatter, parseSkill, readSkillTree, stableId, toSupportConfig } from '../src/modules/knowledge/skill-md.js';
import { chunkMarkdown, terms } from '../src/modules/knowledge/text.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const REFUNDS = `# Політика повернень

## Подвійне списання
Якщо ту саму суму списали двічі протягом 10 хвилин, повертаємо пізніше списання. Повернення до 2000.00 UAH пропонує AI, оператор погоджує.

## Терміни
Кошти надходять на картку протягом 3–5 робочих днів після погодження.

## Що не повертаємо
Використані дні абонемента та персональні тренування, які вже відбулися.`;
const PLANS = `# Тарифи та оплата

## Premium monthly
Premium monthly коштує 799.00 UAH на місяць і списується щомісяця в день оформлення.

## Annual
Річний план коштує 7990.00 UAH за рік. Скасування річного плану розглядає менеджер.`;
const HOURS = 'Hours: the gym is open from 6:00 to 23:00 every day, including holidays.';

const docs: KnowledgeDoc[] = [
  { id: 'refunds', title: 'Політика повернень', content: REFUNDS, version: 2, category: 'Billing' },
  { id: 'plans', title: 'Тарифи та оплата', content: PLANS, version: 1, category: 'Billing' },
  { id: 'hours', title: 'Opening hours', content: HOURS, version: 1, category: 'Support' },
];

test('chunking keeps the heading path and UA/EN terms meet on shared canonical forms', () => {
  const chunks = chunkMarkdown('Політика повернень', REFUNDS);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(c => c.headingPath.startsWith('Політика повернень')));
  assert.ok(chunks.some(c => c.headingPath.endsWith('Подвійне списання')));
  assert.deepEqual(terms('charged twice'), terms('списали двічі'));
  assert.ok(terms('refund').includes('refund') && terms('повернення').includes('refund'));
});

test('hybrid retrieval answers Ukrainian and English questions with the right section', async () => {
  const retriever = new KnowledgeRetriever();
  const ua = await retriever.search(docs, 'мені списали двічі, коли повернуть гроші?');
  assert.equal(ua[0]?.id, 'refunds');
  assert.match(ua[0]!.content, /пізніше списання|3–5 робочих днів/);
  const en = await retriever.search(docs, 'I was charged twice');
  assert.equal(en[0]?.id, 'refunds');
  assert.equal(en[0]!.section, 'Політика повернень › Подвійне списання');
  const price = await retriever.search(docs, 'скільки коштує преміум?');
  assert.equal(price[0]?.id, 'plans');
  assert.match(price[0]!.content, /799\.00 UAH/);
  assert.equal((await retriever.search(docs, 'when are you open?'))[0]?.id, 'hours');
});

test('retrieval returns at most k documents, two passages each, and nothing for empty queries', async () => {
  const retriever = new KnowledgeRetriever();
  const result = await retriever.explain(docs, 'повернення списання оплата річний план', { k: 2 });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.embedder, 'local:hashing-v1:768');
  assert.ok(result.hits.length <= 2);
  assert.ok(result.hits.every(hit => hit.passages.length <= 2 && hit.passages.every(p => p.lexicalRank !== null || (p.similarity ?? 0) >= 0.22)));
  assert.deepEqual(await retriever.search(docs, '   '), []);
  assert.deepEqual(await retriever.search(docs, 'і та на'), []);
  assert.deepEqual(await retriever.search([], 'refund'), []);
});

test('the index is cached per version and a new version replaces the old one', async () => {
  const retriever = new KnowledgeRetriever();
  await retriever.search(docs, 'refund');
  assert.equal(retriever.cachedDocuments, 3);
  const updated = docs.map(d => d.id === 'hours' ? { ...d, version: 2, content: 'Hours: open from 7:00 to 22:00.' } : d);
  const hits = await retriever.search(updated, 'opening hours');
  assert.equal(retriever.cachedDocuments, 3);
  assert.match(hits[0]!.content, /7:00 to 22:00/);
  assert.equal(hits[0]!.version, 2);
});

const setup = (model: AgentModel = new RulesModel()) => {
  const store = new MemorySupportStore(seedData());
  return { store, harness: new SupportHarness({ store, model, fallback: new RulesModel(), provider: new SimulatedPaymentProvider(), timeoutMs: 500 }) };
};
const publish = (store: MemorySupportStore, businessId: string, id: string, title: string, content: string) =>
  store.saveKnowledge({ id, businessId, title, category: 'Support', content, version: 1, status: 'published', updatedAt: new Date().toISOString() });

test('the agent cites only retrieved sources, so revoking an unrelated document keeps the reply visible', async () => {
  const h = setup();
  const c = await h.harness.openCase('demo-olena');
  const hours = await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000901', 'Opening hours', HOURS);
  const unrelated = await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000902', 'Parking', 'Parking is free for members in the underground garage.');
  const result = await h.harness.runTurn('demo-olena', c.id, 'what are your opening hours?');
  assert.match(result.reply!.body, /6:00 to 23:00/);
  assert.deepEqual(result.reply!.sourceRefs, [{ id: hours.id, version: 1 }]);
  const searched = (await h.harness.detail(c.id)).audit.find(event => event.type === 'knowledge.searched');
  assert.ok(searched, 'retrieval is audited');

  await h.store.saveKnowledge({ ...unrelated, status: 'revoked', version: 2 }, 1);
  assert.match((await h.harness.customerCase('demo-olena', c.id)).messages.map(m => m.body).join(' '), /6:00 to 23:00/);
  await h.store.saveKnowledge({ ...hours, status: 'revoked', version: 2 }, 1);
  assert.doesNotMatch((await h.harness.customerCase('demo-olena', c.id)).messages.map(m => m.body).join(' '), /6:00 to 23:00/);
});

test('the model tool receives ranked passages with their section, never drafts or other businesses', async () => {
  let seen: { id: string; content: string }[] = [];
  const decision: AgentDecision = { intent: 'other', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply: 'ok', action: null };
  const h = setup(new ScriptedModel(async ctx => { seen = await ctx.searchKnowledge("charged twice refund"); return decision; }));
  const c = await h.harness.openCase('demo-olena');
  const businesses = await h.store.businessesList();
  const other = businesses.find(b => b.id !== c.businessId)!;
  await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000903', 'Політика повернень', REFUNDS);
  await h.store.saveKnowledge({ id: '00000000-0000-4000-8000-000000000904', businessId: c.businessId, title: 'Draft refunds', category: 'Billing', content: 'DRAFT refund twice charged', version: 1, status: 'draft', updatedAt: new Date().toISOString() });
  await publish(h.store, other.id, '00000000-0000-4000-8000-000000000905', 'Other refunds', 'OTHER business refund twice charged');
  await h.harness.runTurn('demo-olena', c.id, 'charged twice');
  assert.deepEqual(seen.map(s => s.id), ['00000000-0000-4000-8000-000000000903']);
  assert.match(seen[0]!.content, /пізніше списання/);
  assert.equal((seen[0] as unknown as { section: string }).section, 'Політика повернень › Подвійне списання');
});

test('operator search route uses the agent retrieval and requires the operator token', async () => {
  const h = setup();
  const businessId = (await h.store.businessesList())[0]!.id;
  await publish(h.store, businessId, '00000000-0000-4000-8000-000000000906', 'Політика повернень', REFUNDS);
  const app = await createApp(settingsFrom({ API_TOKEN: 't', OPERATOR_TOKEN: 'operator-token' }), { store: {} as never, dispatch: async () => undefined, checks: {}, support: { harness: h.harness, store: h.store } });
  try {
    const headers = { host: 'testserver', authorization: 'Bearer operator-token' };
    const ok = await app.inject({ url: `/api/v1/knowledge/search?businessId=${businessId}&q=${encodeURIComponent('списали двічі')}`, headers });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().mode, 'hybrid');
    assert.equal(ok.json().hits[0].id, '00000000-0000-4000-8000-000000000906');
    assert.equal((await app.inject({ url: `/api/v1/knowledge/search?q=x`, headers: { host: 'testserver' } })).statusCode, 401);
    assert.equal((await app.inject({ url: `/api/v1/knowledge/search?businessId=${businessId}`, headers })).statusCode, 422);
    assert.equal((await app.inject({ url: '/api/v1/capabilities', headers })).json().knowledgeSearch, 'hybrid');
  } finally { await app.close(); }
});

const SKILL_BUSINESS = `---
name: novapay-refund-policy
description: >
  NovaPay refund policy: duplicate charges,
  limits and timelines.
metadata:
  layer: business
  business: novapay-fitness
  title: Refund policy
  category: Billing
  version: v2
  status: Published
  updated: "2026-10-30"
  source: https://help.novapay-fitness.test/refunds
---

${REFUNDS}`;
const SKILL_UNIVERSAL = `---
name: refund-request
description: Handle any request for money back.
metadata:
  layer: universal
  version: "1"
---

# Refund request

## Steps
1. Look up the customer's payments.
2. Read the business refund policy with search_knowledge.`;

test('SKILL.md packs parse into knowledge sources and skills accepted by the support config schema', async () => {
  assert.equal(parseFrontmatter(SKILL_BUSINESS).data.description, 'NovaPay refund policy: duplicate charges, limits and timelines.');
  const business = parseSkill('novapay-fitness/novapay-refund-policy/SKILL.md', SKILL_BUSINESS);
  assert.deepEqual([business.layer, business.business, business.title, business.version, business.status], ['business', 'novapay-fitness', 'Refund policy', 2, 'published']);
  assert.throws(() => parseSkill('x/SKILL.md', '---\ndescription: no name\n---\nbody'), /needs a name/);

  const root = await mkdtemp(join(tmpdir(), 'kb-skills-'));
  for (const [dir, text] of [['novapay-fitness/novapay-refund-policy', SKILL_BUSINESS], ['universal/refund-request', SKILL_UNIVERSAL], ['novapay-fitness/novapay-fitness-assistant-settings', '---\nname: novapay-fitness-assistant-settings\ndescription: Tone and approvals.\nmetadata:\n  layer: business\n  business: novapay-fitness\n---\n\n# Settings\n\nReply in Ukrainian.'], ['eldhall/eldhall-refund-policy', SKILL_BUSINESS.replace('business: novapay-fitness', 'business: eldhall').replace('name: novapay-refund-policy', 'name: eldhall-refund-policy')]] as const) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'SKILL.md'), text);
  }
  const seed = seedData();
  const nova = seed.businesses.find(b => b.slug === 'novapay-fitness')!;
  const imported = toSupportConfig(await readSkillTree(root), nova.id, 'novapay-fitness');
  assert.equal(imported.knowledge.length, 1, 'other businesses are skipped');
  assert.deepEqual(imported.skills.map(s => s.name).sort(), ['novapay-fitness/assistant-settings', 'universal/refund-request']);
  assert.equal(imported.knowledge[0]!.id, stableId(nova.id, 'knowledge', 'novapay-refund-policy'));
  assert.match(imported.knowledge[0]!.content, /Джерело: https:\/\/help\.novapay-fitness\.test\/refunds$/);
  const parsed = supportConfigSchema.parse({ version: 1, businesses: [{ id: nova.id, slug: nova.slug, name: nova.name, currency: nova.currency, policy: nova.policy }], ...imported });
  assert.equal(parsed.knowledge[0]!.version, 2);
});
