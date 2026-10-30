import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { environmentFiles, loadEnvironment, settingsFrom } from '../src/core/config.js';
import { brokerOptions } from '../src/core/queue.js';
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
  const credentials = { ...production, POSTGRES_PASSWORD: 'p'.repeat(32), REDIS_PASSWORD: 'r'.repeat(32), RABBITMQ_PASSWORD: 'q'.repeat(32) };
  assert.throws(() => settingsFrom(credentials), /API_TOKEN/);
  assert.throws(() => settingsFrom({ ...credentials, API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '["*"]' }), /ALLOWED_HOSTS/);
  assert.throws(() => settingsFrom({ ...credentials, API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '[]' }), /ALLOWED_HOSTS/);
  assert.equal(settingsFrom({ ...credentials, API_TOKEN: 't'.repeat(32), ALLOWED_HOSTS: '["api.example.com"]' }).environment, 'production');
  for (const env of [{ POSTGRES_PORT: '0' }, { REDIS_PORT: 'x' }, { ENVIRONMENT: 'test' }, { CORS_ORIGINS: 'null' }, { ALLOWED_HOSTS: '[23]' }, { WORKER_CONCURRENCY: '99' }]) {
    assert.throws(() => settingsFrom(env));
  }
});

test('AMQP options retain credentials and compensate the library virtual-host unescape', () => {
  const password = 'a:@/+#%? $password';
  const settings = settingsFrom({ POSTGRES_PASSWORD: password, REDIS_PASSWORD: password, RABBITMQ_PASSWORD: password, RABBITMQ_USER: 'user@name', RABBITMQ_VHOST: 'my/vhost' });
  assert.equal(settings.postgresPassword, password);
  assert.equal(settings.redisPassword, password);
  assert.deepEqual(brokerOptions(settings), { protocol: 'amqp', hostname: 'rabbitmq', port: 5672, username: 'user@name', password, vhost: 'my%2Fvhost', heartbeat: 15 });
  const literalPercent = brokerOptions(settingsFrom({ RABBITMQ_VHOST: 'tenant%2Fprod' }));
  assert.equal(decodeURIComponent(literalPercent.vhost), 'tenant%2Fprod');
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
