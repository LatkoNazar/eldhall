import assert from 'node:assert/strict';
import { test } from 'node:test';
import type pg from 'pg';
import { createApp } from '../src/app.js';
import { staffTokenMatches, tokenMatches } from '../src/core/auth.js';
import { settingsFrom } from '../src/core/config.js';
import { SupportHarness } from '../src/modules/agent/harness.js';
import { RulesModel } from '../src/modules/agent/model.js';
import type { InsightsRepository } from '../src/modules/insights/repository.js';
import { InsightsService } from '../src/modules/insights/service.js';
import { createSupport } from '../src/modules/support/factory.js';
import { SimulatedPaymentProvider } from '../src/modules/support/payment-provider.js';
import { seedData } from '../src/modules/support/seed.js';
import { MemorySupportStore } from '../src/modules/support/store.js';
import { MemoryStore } from './helpers.js';

const staffToken = 'staff-token-case-Sensitive';
async function appFixture(operatorToken: string) {
  const store = new MemorySupportStore(seedData());
  const rules = new RulesModel();
  const harness = new SupportHarness({ store, model: rules, fallback: rules, provider: new SimulatedPaymentProvider(), timeoutMs: 1000 });
  let insightReads = 0;
  const repository = { list: async () => { insightReads++; return []; } } as unknown as InsightsRepository;
  const insights = new InsightsService(repository, undefined, 1000);
  const app = await createApp(settingsFrom({ OPERATOR_TOKEN: operatorToken, API_TOKEN: '', DEMO_RESET_ENABLED: 'false' }), {
    store: new MemoryStore(), dispatch: async () => undefined, checks: {}, support: { store, harness }, insights,
  });
  return { app, insightReads: () => insightReads };
}

test('strict staff auth rejects blank configuration while legacy optional jobs auth remains explicit', () => {
  assert.equal(tokenMatches(undefined, ''), true);
  for (const expected of ['', ' ', '\t', ' a token ']) {
    for (const header of [undefined, '', 'Bearer ', 'Bearer arbitrary', 'Bearer ' + expected]) assert.equal(staffTokenMatches(header, expected), false);
  }
  for (const header of [undefined, staffToken, 'Basic ' + staffToken, 'Bearer wrong', 'Bearer', 'Bearer  ' + staffToken, 'Bearer ' + staffToken + ' ', 'Bearer\t' + staffToken, 'Bearer ' + staffToken + '\n', 'Bearer ' + staffToken.toUpperCase()]) {
    assert.equal(staffTokenMatches(header, staffToken), false);
  }
  assert.equal(staffTokenMatches('Bearer ' + staffToken, staffToken), true);
  assert.equal(staffTokenMatches('bearer ' + staffToken, staffToken), true, 'Bearer scheme names are case-insensitive; credentials are not');
});

test('all staff HTTP groups fail closed with empty/whitespace configuration without protecting optional legacy jobs', async () => {
  for (const configured of ['', ' ']) {
    const { app, insightReads } = await appFixture(configured);
    try {
      const businessId = seedData().businesses[0]!.id;
      for (const authorization of [undefined, 'Bearer arbitrary']) {
        const headers = authorization ? { authorization } : {};
        for (const url of ['/api/v1/operator/session', '/api/v1/businesses', '/api/v1/insights/runs?businessId=' + businessId, '/api/v1/integrations?businessId=' + businessId]) {
          const response = await app.inject({ url, headers });
          assert.equal(response.statusCode, 401);
          assert.deepEqual(response.json(), { detail: 'Invalid operator token' });
          assert.equal(response.headers['www-authenticate'], 'Bearer');
        }
        const mutation = await app.inject({ url: '/api/v1/insights/runs', method: 'POST', headers, payload: { businessId } });
        assert.equal(mutation.statusCode, 401);
      }
      assert.equal(insightReads(), 0, 'no private insights query is reached');
      const legacy = await app.inject({ url: '/api/v1/jobs', method: 'POST', payload: { text: 'legacy optional auth' } });
      assert.equal(legacy.statusCode, 202);
    } finally { await app.close(); }
  }
});

test('configured staff HTTP groups reject malformed credentials and allow exact valid bearers', async () => {
  const { app, insightReads } = await appFixture(staffToken);
  try {
    const businessId = seedData().businesses[0]!.id;
    const urls = ['/api/v1/operator/session', '/api/v1/businesses', '/api/v1/insights/runs?businessId=' + businessId, '/api/v1/integrations?businessId=' + businessId];
    for (const authorization of [undefined, 'Basic ' + staffToken, 'Bearer wrong', 'Bearer', 'Bearer  ' + staffToken, 'Bearer ' + staffToken + ' ', 'Bearer\t' + staffToken, 'Bearer ' + staffToken.toUpperCase()]) {
      for (const url of urls) {
        const response = await app.inject({ url, headers: authorization ? { authorization } : {} });
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), { detail: 'Invalid operator token' });
        assert.equal(response.headers['www-authenticate'], 'Bearer');
      }
    }
    assert.equal(insightReads(), 0);
    for (const url of urls) assert.equal((await app.inject({ url, headers: { authorization: 'Bearer ' + staffToken } })).statusCode, 200);
    assert.equal(insightReads(), 1);
  } finally { await app.close(); }
});

test('production rejects public example API/operator tokens even when they exceed the minimum length', async () => {
  const production = { ENVIRONMENT: 'production', POSTGRES_PASSWORD: 'p'.repeat(32), REDIS_PASSWORD: 'r'.repeat(32), API_TOKEN: 'a'.repeat(32), ALLOWED_HOSTS: '["api.example.com"]', SUPPORT_STORE: 'postgres', LLM_PROVIDER: 'rules' };
  // createSupport's own token check is under test, not the store: swap in memory after config validation so no database is needed.
  const support = (env: Record<string, string>) => ({ ...settingsFrom(env), supportStore: 'memory' as const, supportExecution: 'inline' as const });
  const exampleApiToken = 'development-token-not-for-production';
  assert.ok(exampleApiToken.length >= 32);
  assert.throws(() => settingsFrom({ ...production, API_TOKEN: exampleApiToken }), /API_TOKEN/);
  assert.throws(() => settingsFrom({ ...production, API_TOKEN: 'replace-with-' + 'x'.repeat(32) }), /API_TOKEN/);
  assert.throws(() => settingsFrom({ ...production, API_TOKEN: 'x'.repeat(32) + ' ' }), /API_TOKEN/);
  const exampleOperatorToken = 'development-operator-token';
  assert.ok(exampleOperatorToken.length >= 24);
  for (const token of ['', 'short', ' ', exampleOperatorToken, 'example-' + 'x'.repeat(24), 'replace-with-' + 'x'.repeat(24), 'x'.repeat(24) + ' ']) {
    await assert.rejects(createSupport(support({ ...production, OPERATOR_TOKEN: token }), {} as pg.Pool), /OPERATOR_TOKEN/);
  }
  const valid = await createSupport(support({ ...production, OPERATOR_TOKEN: 's'.repeat(32) }), {} as pg.Pool);
  assert.equal(valid.capabilities?.runtime, 'rules');
});
