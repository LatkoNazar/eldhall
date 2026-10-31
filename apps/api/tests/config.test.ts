import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { environmentFiles, loadEnvironment, settingsFrom } from '../src/core/config.js';
import { createWorkerRedis, jobOptions } from '../src/core/queue.js';
import { hostAllowed, tokenMatches } from '../src/core/auth.js';

test('environment discovery and precedence from root, package and standalone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'node-api-env-'));
  try {
    const root = join(directory, 'repo');
    const api = join(root, 'apps', 'api');
    mkdirSync(api, { recursive: true });
    writeFileSync(join(root, 'compose.yaml'), 'services: {}');
    writeFileSync(join(root, '.env'), 'POSTGRES_DB=root\nAPI_TOKEN=root-token\nREDIS_PASSWORD="special # @ password"\n');
    writeFileSync(join(api, '.env'), 'POSTGRES_DB=package\n');
    assert.deepEqual(environmentFiles(api), [join(root, '.env'), join(api, '.env')]);
    assert.equal(loadEnvironment(root, {}).POSTGRES_DB, 'root');
    assert.equal(loadEnvironment(api, {}).POSTGRES_DB, 'package');
    assert.equal(loadEnvironment(api, { POSTGRES_DB: 'process' }).POSTGRES_DB, 'process');
    assert.equal(loadEnvironment(api, {}).REDIS_PASSWORD, 'special # @ password');
    assert.deepEqual(environmentFiles(directory), [join(directory, '.env')]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production requires strong credentials, token and explicit hosts without echoing secrets', () => {
  const production = { ENVIRONMENT: 'production' };
  assert.throws(() => settingsFrom(production), /passwords/);
  const credentials = { ...production, POSTGRES_PASSWORD: 'p'.repeat(32), REDIS_PASSWORD: 'r'.repeat(32) };
  assert.throws(() => settingsFrom(credentials), /API_TOKEN/);
  assert.throws(() => settingsFrom({ ...credentials, API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '["*"]' }), /ALLOWED_HOSTS/);
  assert.throws(() => settingsFrom({ ...credentials, API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '[]' }), /ALLOWED_HOSTS/);
  assert.equal(settingsFrom({ ...credentials, API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '["api.example.com"]' }).environment, 'production');
  for (const env of [{ POSTGRES_PORT: '0' }, { REDIS_PORT: 'x' }, { ENVIRONMENT: 'test' }, { CORS_ORIGINS: 'null' }, { ALLOWED_HOSTS: '[23]' }, { WORKER_CONCURRENCY: '99' }]) {
    assert.throws(() => settingsFrom(env));
  }
});

test('Redis queue uses isolated storage, resilient worker options and bounded retention', () => {
  const password = 'a:@/+#%? $password';
  const settings = settingsFrom({ POSTGRES_PASSWORD: password, REDIS_PASSWORD: password });
  assert.equal(settings.postgresPassword, password);
  assert.equal(settings.redisPassword, password);
  assert.equal(settings.bullmqDb, 2);
  assert.equal(settings.bullmqPrefix, 'node-bullmq');
  const worker = createWorkerRedis(settings);
  assert.equal(worker.options?.password, password);
  assert.equal(worker.options?.database, 2);
  assert.equal(worker.options?.disableOfflineQueue, false);
  assert.equal(typeof worker.options?.socket?.reconnectStrategy, 'function');
  assert.deepEqual(jobOptions(settings), { attempts: 4, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400, count: 1000 } });
  for (const env of [{ BULLMQ_DB: '1' }, { BULLMQ_DB: '16' }, { BULLMQ_PREFIX: 'bad:prefix' }, { BULLMQ_QUEUE: '' }, { BULLMQ_RETENTION_COUNT: '0' }, { BULLMQ_ATTEMPTS: '11' }, { BULLMQ_COMPLETED_RETENTION_SECONDS: '0' }]) assert.throws(() => settingsFrom(env));
});

test('Bearer parser rejects missing scheme, Basic, wrong token and extra whitespace', () => {
  assert.equal(tokenMatches(undefined, ''), true);
  assert.equal(tokenMatches('Bearer secret', 'secret'), true);
  assert.equal(tokenMatches('bearer secret', 'secret'), true);
  for (const header of [undefined, 'secret', 'Basic secret', 'Bearer wrong', 'Bearer', 'Bearer  secret', 'Bearer secret ', 'Bearer\tsecret']) {
    assert.equal(tokenMatches(header, 'secret'), false, header);
  }
});

test('allowed hosts support ports and subdomain wildcard without suffix bypass', () => {
  assert.equal(hostAllowed('localhost:8000', ['localhost']), true);
  assert.equal(hostAllowed('API.EXAMPLE.COM:443', ['api.example.com']), true);
  assert.equal(hostAllowed('a.example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('example.com', ['*.example.com']), false);
  assert.equal(hostAllowed('notexample.com', ['*.example.com']), false);
  assert.equal(hostAllowed('api.example.com.evil.test', ['api.example.com']), false);
  assert.equal(hostAllowed('api.example.com@evil.test', ['api.example.com']), false);
  assert.equal(hostAllowed('[::1]:8000', ['[::1]']), true);
  assert.equal(hostAllowed('anything', ['*']), true);
});

test('DSH routing supports Gemini key aliases and explicit local endpoints without secret output', () => {
  const defaults = settingsFrom({});
  assert.equal(defaults.agentRuntime, 'rules');
  assert.equal(defaults.supportExecution, 'inline');
  assert.equal(settingsFrom({ SUPPORT_STORE: 'postgres' }).supportExecution, 'worker');
  const gemini = settingsFrom({ LLM_PROVIDER: 'google', GEMINI_API_KEY: 'g-primary', GOOGLE_GENERATIVE_AI_API_KEY: 'g-legacy' });
  assert.equal(gemini.agentRuntime, 'dsh');
  assert.equal(gemini.llmModel, 'gemini-3.5-flash-lite');
  assert.equal(gemini.llmApiKey, 'g-primary');
  const local = settingsFrom({ LLM_PROVIDER: 'local', LLM_MODEL: 'local-support', LLM_BASE_URL: 'http://127.0.0.1:1234/v1' });
  assert.equal(local.agentRuntime, 'dsh');
  assert.equal(local.llmApiKey, '');
  assert.equal(local.maxRuntimeToolCalls, 8);
  for (const invalid of [{ AGENT_RUNTIME: 'other' }, { AGENT_RUNTIME: 'dsh' }, { LLM_PROVIDER: 'local' }, { LLM_PROVIDER: 'google', LLM_BASE_URL: 'file:///x' }, { MAX_RUNTIME_TOOL_CALLS: '0' }]) assert.throws(() => settingsFrom(invalid));
});

test('a dedicated OpenRouter Decisions classifier keeps model routes and credentials independent', () => {
  const defaults = settingsFrom({});
  assert.equal(defaults.classificationProvider, 'agent');
  const settings = settingsFrom({
    LLM_PROVIDER: 'google', GEMINI_API_KEY: 'synthetic-gemini-key', OPENAI_API_KEY: 'synthetic-unrelated-key',
    CLASSIFICATION_PROVIDER: 'openrouter', CLASSIFICATION_MODEL: 'openai/gpt-6-luna-decisions',
    OPENROUTER_API_KEY: 'synthetic-decisions-key',
  });
  assert.equal(settings.llmProvider, 'google');
  assert.equal(settings.llmModel, 'gemini-3.5-flash-lite');
  assert.equal(settings.llmApiKey, 'synthetic-gemini-key');
  assert.equal(settings.classificationModel, 'openai/gpt-6-luna-decisions');
  assert.equal(settings.classificationApiKey, 'synthetic-decisions-key');
  assert.equal(settings.classificationTimeoutMs, 10000);
  assert.equal(settingsFrom({ OPENAI_API_KEY: 'synthetic-unrelated-key' }).classificationApiKey, '');
  assert.throws(() => settingsFrom({ CLASSIFICATION_PROVIDER: 'openrouter' }), /explicit CLASSIFICATION_MODEL/);
  assert.throws(() => settingsFrom({ CLASSIFICATION_PROVIDER: 'unknown' }), /CLASSIFICATION_PROVIDER/);
  assert.throws(() => settingsFrom({ CLASSIFICATION_TIMEOUT_MS: '0' }), /CLASSIFICATION_TIMEOUT_MS/);
});
