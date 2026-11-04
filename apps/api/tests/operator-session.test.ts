import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import type { JobStore } from '../src/modules/jobs/repository.js';
import { createSupport } from '../src/modules/support/factory.js';

test('operator key check is pure, uncached and independent of business/service availability', async () => {
  let sideEffects = 0;
  const forbidden = async (): Promise<never> => { sideEffects++; throw new Error('Service access forbidden'); };
  const store: JobStore = { create: forbidden, find: forbidden, running: forbidden, succeeded: forbidden, failed: forbidden };
  const key = 'synthetic-operator-key-Case-Sensitive';
  const app = await createApp(settingsFrom({ OPERATOR_TOKEN: key, API_TOKEN: 'separate-jobs-key' }), { store, dispatch: forbidden, readJob: forbidden, checks: { postgres: forbidden, redis: forbidden, provider: forbidden } });
  try {
    for (const authorization of [undefined, '', 'Basic ' + key, 'Bearer wrong-key', 'Bearer separate-jobs-key', 'Bearer ' + key.toUpperCase(), 'Bearer  ' + key, 'Bearer ' + key + ' ']) {
      const result = await app.inject({ url: '/api/v1/operator/session', headers: { ...(authorization === undefined ? {} : { authorization }), 'x-customer-session': key } });
      assert.equal(result.statusCode, 401);
      assert.deepEqual(result.json(), { detail: 'Invalid operator token' });
      assert.equal(result.headers['www-authenticate'], 'Bearer');
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(result.headers['set-cookie'], undefined);
      assert.doesNotMatch(result.body, /synthetic-operator|separate-jobs-key/);
    }
    for (const scheme of ['Bearer', 'bearer']) {
      const result = await app.inject({ url: '/api/v1/operator/session', headers: { authorization: scheme + ' ' + key } });
      assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), { authenticated: true });
      assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['set-cookie'], undefined);
    }
    assert.equal(sideEffects, 0, 'Authentication must never touch storage, queues, readiness or providers');
  } finally { await app.close(); }
});

test('operator check denies empty/whitespace server configuration instead of inheriting optional jobs auth', async () => {
  for (const key of ['', ' ']) {
    const forbidden = async (): Promise<never> => { throw new Error('Service access forbidden'); };
    const app = await createApp(settingsFrom({ OPERATOR_TOKEN: key }), { store: { create: forbidden, find: forbidden, running: forbidden, succeeded: forbidden, failed: forbidden }, dispatch: forbidden, checks: {} });
    try { assert.equal((await app.inject({ url: '/api/v1/operator/session', headers: { authorization: 'Bearer arbitrary' } })).statusCode, 401); }
    finally { await app.close(); }
  }
});

test('the public local-demo key remains forbidden by the unchanged production support guard', async () => {
  const settings = settingsFrom({ ENVIRONMENT: 'production', POSTGRES_PASSWORD: 'p'.repeat(32), REDIS_PASSWORD: 'r'.repeat(32), API_TOKEN: 'a'.repeat(32), OPERATOR_TOKEN: '1111', ALLOWED_HOSTS: '["api.example.invalid"]', SUPPORT_STORE: 'postgres', LLM_PROVIDER: 'rules' });
  const pool = new pg.Pool({ host: '127.0.0.1', port: 9, user: 'synthetic', password: 'synthetic', database: 'not-used' });
  try { await assert.rejects(createSupport(settings, pool), /Production OPERATOR_TOKEN/); }
  finally { await pool.end(); }
});
