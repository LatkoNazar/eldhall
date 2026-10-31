import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel, ScriptedModel, type AgentDecision, type AgentModel } from '../src/modules/agent/model.js';
import { KnowledgeRetriever, type KnowledgeDoc } from '../src/modules/knowledge/retriever.js';
import { createEmbedder, HashingEmbedder, RemoteEmbedder } from '../src/modules/knowledge/embeddings.js';
import { configureKnowledge } from '../src/modules/knowledge/runtime.js';
import { PgVectorStore } from '../src/modules/knowledge/vector-store.js';
import { migrateSupport } from '../src/modules/support/migrations.js';
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

test('follow-up replies keep eligible source fences even without a fresh search', async () => {
  let turn = 0;
  const decision: AgentDecision = { intent: 'other', summary: 's', reasoning: 'r', sentiment: { label: 'calm', urgency: 'low' }, reply: HOURS, action: null };
  const h = setup(new ScriptedModel(async ctx => {
    if (turn++ === 0) await ctx.searchKnowledge('opening hours');
    return decision;
  }));
  const c = await h.harness.openCase('demo-olena');
  const hours = await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000901', 'Opening hours', HOURS);
  const unrelated = await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000902', 'Parking', 'Parking is free for members in the underground garage.');
  const internal = await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000907', 'Private hours', 'Private staff schedule');
  await h.store.saveKnowledge({ ...internal, audience: 'internal', version: 2 }, 1);
  const restricted = await publish(h.store, c.businessId, '00000000-0000-4000-8000-000000000908', 'Restricted hours', 'Premium-only schedule');
  await h.store.saveKnowledge({ ...restricted, plans: ['unrelated-plan'], version: 2 }, 1);
  await h.harness.runTurn('demo-olena', c.id, 'what are your opening hours?');
  const followup = await h.harness.runTurn('demo-olena', c.id, 'repeat that');
  assert.deepEqual(followup.reply!.sourceRefs, [hours, unrelated].map(({ id, version }) => ({ id, version })));
  assert.match(followup.reply!.body, /6:00 to 23:00/);
  assert.equal((await h.harness.detail(c.id)).audit.filter(event => event.type === 'knowledge.searched').length, 1);
  await h.store.saveKnowledge({ ...hours, status: 'revoked', version: 2 }, 1);
  assert.doesNotMatch((await h.harness.customerCase('demo-olena', c.id)).messages.filter(m => m.role === 'assistant').map(m => m.body).join(' '), /6:00 to 23:00/);
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
  assert.equal(imported.knowledge[0]!.sourceUrl, 'https://help.novapay-fitness.test/refunds');
  assert.equal(imported.knowledge[0]!.audience, 'customer');
  const parsed = supportConfigSchema.parse({ version: 1, businesses: [{ id: nova.id, slug: nova.slug, name: nova.name, currency: nova.currency, policy: nova.policy }], ...imported });
  assert.equal(parsed.knowledge[0]!.version, 2);
});

// ---------- v2: access, embedders, imports, history, pgvector ----------

test('audience and plan filters: internal sources never reach the customer agent; plan-specific sources only that plan', async () => {
  const retriever = new KnowledgeRetriever();
  const scoped: KnowledgeDoc[] = [
    ...docs,
    { id: 'playbook', title: 'Escalation playbook', content: 'Refund twice charged: escalate refunds above the limit to the senior agent.', version: 1, audience: 'internal' },
    { id: 'annual', title: 'Annual plan terms', content: 'Annual plan refund: any refund of the annual plan is reviewed by a manager within 1 business day.', version: 1, plans: ['Annual'] },
  ];
  const customer = (await retriever.search(scoped, 'refund annual plan', { plan: 'Premium monthly' })).map(h => h.id);
  assert.ok(!customer.includes('playbook') && !customer.includes('annual'));
  assert.ok((await retriever.search(scoped, 'refund annual plan', { plan: 'Annual' })).some(h => h.id === 'annual'));
  assert.ok((await retriever.search(scoped, 'escalate refunds senior agent', { audience: 'any' })).some(h => h.id === 'playbook'));
});

test('a failing embedding model degrades to lexical search instead of failing the turn', async () => {
  const broken = { id: 'openai:broken:768', provider: 'openai' as const, model: 'broken', dimensions: 768, minSimilarity: 0.3, embed: async () => { throw new Error('down'); } };
  const result = await new KnowledgeRetriever(broken).explain(docs, 'charged twice');
  assert.equal(result.mode, 'lexical');
  assert.equal(result.hits[0]?.id, 'refunds');
  assert.ok(result.hits[0]!.passages.every(p => p.vectorRank === null));
});

test('hosted embedders call OpenAI and Google with 768 dimensions and normalise the vectors', async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
    const body = url.includes('openai') ? { data: [{ index: 0, embedding: vector }] } : { embeddings: [{ values: vector }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const openai = new RemoteEmbedder('openai', 'text-embedding-3-small', 'sk-test', fake);
  const [vector] = await openai.embed(['hello'], 'document');
  assert.equal(openai.id, 'openai:text-embedding-3-small:768');
  assert.ok(Math.abs(vector![0]! - 0.6) < 1e-9 && Math.abs(vector![1]! - 0.8) < 1e-9);
  assert.equal(calls[0]!.body.dimensions, 768);
  assert.equal(calls[0]!.headers.Authorization, 'Bearer sk-test');
  await new RemoteEmbedder('google', 'gemini-embedding-001', 'g-test', fake).embed(['q'], 'query');
  assert.match(calls[1]!.url, /gemini-embedding-001:batchEmbedContents$/);
  assert.deepEqual((calls[1]!.body.requests as { taskType: string; outputDimensionality: number }[])[0], { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'q' }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768 });
  assert.throws(() => createEmbedder('openai', '', ''), /needs an API key/);
});

test('operator routes: drafts from upload and allow-listed URL, version history, audience-aware search, index and reindex', async () => {
  const h = setup();
  const businessId = (await h.store.businessesList())[0]!.id;
  configureKnowledge({ retriever: new KnowledgeRetriever(), urlAllowlist: ['help.novapay-fitness.test'], fetcher: async url => ({ url: url.toString(), contentType: 'text/html', body: '<html><title>Години роботи</title><body><main><h1>Години роботи</h1><p>Зал працює з 6:00 до 23:00.</p><script>alert(1)</script></main></body></html>' }) });
  const app = await createApp(settingsFrom({ API_TOKEN: 't', OPERATOR_TOKEN: 'operator-token' }), { store: {} as never, dispatch: async () => undefined, checks: {}, support: { harness: h.harness, store: h.store } });
  const headers = { host: 'testserver', authorization: 'Bearer operator-token' };
  try {
    const upload = await app.inject({ method: 'POST', url: `/api/v1/knowledge/upload?businessId=${businessId}`, headers, payload: { filename: 'refunds.md', contentBase64: Buffer.from(REFUNDS).toString('base64'), category: 'Billing' } });
    assert.equal(upload.statusCode, 201, upload.body);
    assert.deepEqual([upload.json().title, upload.json().status, upload.json().audience], ['Політика повернень', 'draft', 'customer']);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/knowledge/upload?businessId=${businessId}`, headers, payload: { filename: 'x.pdf', contentBase64: 'AAAA', category: 'Billing' } })).statusCode, 415);
    const page = await app.inject({ method: 'POST', url: `/api/v1/knowledge/import-url?businessId=${businessId}`, headers, payload: { url: 'https://help.novapay-fitness.test/hours', category: 'Support' } });
    assert.equal(page.statusCode, 201, page.body);
    assert.equal(page.json().sourceUrl, 'https://help.novapay-fitness.test/hours');
    assert.doesNotMatch(page.json().content, /alert/);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/knowledge/import-url?businessId=${businessId}`, headers, payload: { url: 'https://evil.example/x', category: 'Support' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/knowledge/import-url?businessId=${businessId}`, headers, payload: { url: 'http://169.254.169.254/latest', category: 'Support' } })).statusCode, 422);

    const internal = await app.inject({ method: 'POST', url: `/api/v1/knowledge?businessId=${businessId}`, headers, payload: { title: 'Ескалація', category: 'Internal', content: 'Повернення понад ліміт двічі списали — ескалація старшому спеціалісту.', audience: 'internal' } });
    for (const doc of [upload.json(), internal.json()]) assert.equal((await app.inject({ method: 'POST', url: `/api/v1/knowledge/${doc.id}/publish?businessId=${businessId}`, headers, payload: { version: 1 } })).statusCode, 200);
    const customerView = (await app.inject({ url: `/api/v1/knowledge/search?businessId=${businessId}&q=${encodeURIComponent('списали двічі')}`, headers })).json();
    assert.ok(!customerView.hits.some((hit: { id: string }) => hit.id === internal.json().id));
    const staffView = (await app.inject({ url: `/api/v1/knowledge/search?businessId=${businessId}&audience=any&q=${encodeURIComponent('списали двічі ескалація')}`, headers })).json();
    assert.ok(staffView.hits.some((hit: { id: string }) => hit.id === internal.json().id));

    const versions = (await app.inject({ url: `/api/v1/knowledge/${upload.json().id}/versions?businessId=${businessId}`, headers })).json().versions;
    assert.deepEqual(versions.map((v: { version: number; status: string }) => [v.version, v.status]), [[2, 'published'], [1, 'draft']]);
    const index = (await app.inject({ url: `/api/v1/knowledge/index?businessId=${businessId}`, headers })).json();
    assert.deepEqual([index.vectorStore, index.embedder.id, index.published, index.urlImport], ['memory', 'local:hashing-v1:768', 2, true]);
    const reindexed = (await app.inject({ method: 'POST', url: `/api/v1/knowledge/reindex?businessId=${businessId}`, headers, payload: {} })).json();
    assert.equal(reindexed.documents, 2);
  } finally { await app.close(); configureKnowledge({ retriever: new KnowledgeRetriever(), urlAllowlist: [] }); }
});

test('pgvector: vectors persist per version and HNSW search feeds the same ranking', { skip: !process.env.TEST_POSTGRES_HOST }, async () => {
  const connection = { host: process.env.TEST_POSTGRES_HOST, port: Number(process.env.TEST_POSTGRES_PORT ?? 5432), database: process.env.TEST_POSTGRES_DB, user: process.env.TEST_POSTGRES_USER, password: process.env.TEST_POSTGRES_PASSWORD };
  const schema = 'kb_test_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool(connection);
  await admin.query('CREATE SCHEMA ' + schema);
  const pool = new pg.Pool({ ...connection, options: '-c search_path=' + schema });
  try {
    await migrateSupport(pool);
    const vectors = await PgVectorStore.connect(pool);
    assert.ok(vectors, 'migration created support_knowledge_chunks');
    const businessId = seedData().businesses[0]!.id;
    const scoped = docs.map(d => ({ ...d, id: randomUUID(), businessId }));
    const retriever = new KnowledgeRetriever(new HashingEmbedder(), vectors);
    const hits = await retriever.search(scoped, 'I was charged twice');
    assert.equal(hits[0]?.title, 'Політика повернень');
    assert.ok(hits[0]!.passages[0]!.vectorRank !== null);
    assert.ok((await vectors!.stats('local:hashing-v1:768')).chunks >= 5);
    const fresh = new KnowledgeRetriever(new HashingEmbedder(), vectors);
    assert.equal((await fresh.search(scoped, 'I was charged twice'))[0]?.title, 'Політика повернень', 'vectors are loaded from Postgres after a restart');
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
