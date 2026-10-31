import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { settingsFrom } from '../src/core/config.js';
import { executeJob } from '../src/modules/jobs/service.js';
import { MemoryStore } from './helpers.js';

test('standalone production smoke honors an explicit Host and runtime token over real HTTP', async () => {
  const store = new MemoryStore();
  const app = await createApp(settingsFrom({ API_TOKEN: 'test-token', ALLOWED_HOSTS: '["smoke.example"]' }), {
    store,
    dispatch: async id => { await executeJob(store, id); },
    checks: { postgres: async () => undefined, redis: async () => undefined },
  });
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/smoke.mjs'], {
        env: { ...process.env, API_TOKEN: 'test-token', SMOKE_HOST: 'smoke.example', SMOKE_BASE_URL: address },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { output += String(chunk); });
      child.on('error', reject);
      child.on('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Smoke OK/);
    assert.equal(store.jobs.size, 2);
  } finally { await app.close(); }
});
