import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootstrapSupportConfig } from '../src/integrations/bootstrap.js';
import { loadSupportConfig, supportConfigSchema } from '../src/integrations/config.js';
import { validateToolInput } from '../src/integrations/schema.js';
import { MemorySupportStore } from '../src/modules/support/store.js';

const example = async () => supportConfigSchema.parse(JSON.parse(await readFile(new URL('../../../examples/support.config.json', import.meta.url), 'utf8')) as unknown);

test('absent config is headless/empty; example mounts reviewed content idempotently without resetting operator guards', async () => {
  assert.deepEqual(await loadSupportConfig(), { version: 1, businesses: [], knowledge: [], skills: [], classifications: [], integrations: [] });
  const config = await example();
  config.integrations[0]!.tools[0]!.name = 'orders.get-status';
  assert.equal(supportConfigSchema.safeParse(config).success, true);
  const store = new MemorySupportStore();
  await bootstrapSupportConfig(store, config);
  await bootstrapSupportConfig(store, config);
  assert.equal((await store.businessesList()).length, 1);
  const businessId = config.businesses[0]!.id;
  assert.equal((await store.knowledge(businessId))[0]?.status, 'published');
  assert.equal((await store.skills(businessId))[0]?.enabled, true);
  const settings = await store.settings(businessId);
  await store.saveSettings({ ...settings, refundLimitCents: 100, version: settings.version + 1 }, settings.version);
  await bootstrapSupportConfig(store, config);
  assert.equal((await store.settings(businessId)).refundLimitCents, 100);
  config.knowledge[0]!.version++;
  config.knowledge[0]!.content = 'Reviewed revision';
  config.skills[0]!.revision++;
  config.skills[0]!.content = 'Updated reviewed skill';
  await bootstrapSupportConfig(store, config);
  assert.equal((await store.knowledge(businessId))[0]?.content, 'Reviewed revision');
  assert.equal((await store.skills(businessId))[0]?.content, 'Updated reviewed skill');
});

test('bootstrap rejects stale payload at same revision and never lets old files replace newer content', async () => {
  const config = await example(); const store = new MemorySupportStore();
  await bootstrapSupportConfig(store, config);
  const businessId = config.businesses[0]!.id;
  config.knowledge[0]!.content = 'Unversioned edit';
  await assert.rejects(bootstrapSupportConfig(store, config), /new version/);
  config.knowledge[0]!.version = 2;
  config.skills[0]!.content = 'Unversioned skill edit';
  await assert.rejects(bootstrapSupportConfig(store, config), /new revision/);
  assert.equal((await store.knowledge(businessId))[0]?.version, 1);
  config.skills[0]!.revision = 2;
  await bootstrapSupportConfig(store, config);
  await bootstrapSupportConfig(store, await example());
  assert.equal((await store.knowledge(businessId))[0]?.version, 2);
});

test('unknown business references, duplicate slugs, and cross-business document ids fail before bootstrap writes', async () => {
  const config = await example(); const store = new MemorySupportStore();
  config.knowledge[0]!.businessId = '10000000-0000-4000-8000-000000000099';
  await assert.rejects(bootstrapSupportConfig(store, config), /unknown business/);
  assert.equal((await store.businessesList()).length, 0);
  const valid = await example(); await bootstrapSupportConfig(store, valid);
  config.knowledge[0]!.businessId = valid.businesses[0]!.id;
  config.businesses[0]!.id = '10000000-0000-4000-8000-000000000099';
  await assert.rejects(bootstrapSupportConfig(store, config), /slug conflicts/);
  const foreign = structuredClone(valid.businesses[0]!); foreign.id = config.businesses[0]!.id; foreign.slug = 'other-store';
  await store.createBusiness(foreign);
  valid.knowledge[0]!.businessId = foreign.id;
  await assert.rejects(bootstrapSupportConfig(store, valid), /distinct id/);
});

test('config rejects insecure URLs, inline credentials, writes, identity schemas and unsupported schema constructs', async () => {
  for (const url of ['not-a-url', 'http://service.example/mcp', 'file:///etc/private', 'https://user:secret@service.example/mcp', 'https://service.example/mcp?token=secret', 'https://service.example/mcp#token', 'http://127.0.0.1:4444/mcp']) {
    const config = await example(); config.integrations[0]!.url = url;
    assert.equal(supportConfigSchema.safeParse(config).success, false);
  }
  const local = await example(); local.integrations[0]!.url = 'http://127.0.0.1:4444/mcp'; local.integrations[0]!.allowInsecureLoopback = true;
  assert.equal(supportConfigSchema.safeParse(local).success, true);
  const config = await example();
  assert.equal(supportConfigSchema.safeParse({ ...config, apiKey: 'inline' }).success, false);
  const tool = config.integrations[0]!.tools[0]!;
  assert.equal(supportConfigSchema.safeParse({ ...config, integrations: [{ ...config.integrations[0], credential: 'inline' }] }).success, false);
  assert.equal(supportConfigSchema.safeParse({ ...config, integrations: [{ ...config.integrations[0], tools: [{ ...tool, access: 'write' }] }] }).success, false);
  assert.equal(supportConfigSchema.safeParse({ ...config, integrations: [{ ...config.integrations[0], tools: [{ ...tool, inputSchema: null }] }] }).success, false);
  tool.inputSchema.properties!.customer_id = { type: 'string' };
  assert.equal(supportConfigSchema.safeParse(config).success, false);
  delete tool.inputSchema.properties!.customer_id;
  tool.inputSchema.$ref = 'https://evil.example/schema';
  assert.equal(supportConfigSchema.safeParse(config).success, false);
});

test('JSON file parsing fails closed on invalid and oversized files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'support-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'support.json');
  await writeFile(path, '{broken'); await assert.rejects(loadSupportConfig(path));
  await writeFile(path, 'x'.repeat(2_000_001)); await assert.rejects(loadSupportConfig(path), /2 MB/);
  await writeFile(path, '{}'); assert.equal((await loadSupportConfig(path)).integrations.length, 0);
});

test('bounded schema validates nested types, required fields, enums and numeric limits', () => {
  const schema = { type: 'object' as const, properties: { items: { type: 'array' as const, maxItems: 1, items: { type: 'integer' as const, minimum: 1, maximum: 3 } }, flag: { type: 'boolean' as const }, mode: { type: 'string' as const, enum: ['known'] } }, required: ['items'], additionalProperties: false as const };
  validateToolInput(schema, { items: [2], flag: true, mode: 'known' });
  for (const input of [{}, { items: [0] }, { items: [4] }, { items: [1, 2] }, { items: [1.5] }, { items: [2], flag: 'true' }, { items: [2], mode: 'unknown' }, { items: [2], extra: true }]) assert.throws(() => validateToolInput(schema, input));
});
