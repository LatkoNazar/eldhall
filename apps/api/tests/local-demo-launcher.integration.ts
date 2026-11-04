import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { get } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGINT');
  const force = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await exit; } finally { clearTimeout(force); }
}

function read(path: string, key?: string) {
  return new Promise<{ status: number | undefined; cache: string | undefined; body: unknown }>((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port: 8000, path, ...(key ? { headers: { authorization: 'Bearer ' + key } } : {}), timeout: 2000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error('Unexpected local demo response size')); });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, cache: response.headers['cache-control'], body: JSON.parse(body) }); }
        catch { reject(new Error('Local demo response is not JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Local demo request timed out')));
    request.on('error', () => reject(new Error('Local demo loopback request failed')));
  });
}

test('actual default demo CLI starts on loopback, ignores ambient app configuration and shuts down its own child', { timeout: 30_000 }, async () => {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/local-demo.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ENVIRONMENT: 'production', OPERATOR_TOKEN: 'ignored-synthetic-key', DATABASE_URL: 'invalid-synthetic-target', REDIS_HOST: 'remote.invalid', LLM_PROVIDER: 'google', AGENT_RUNTIME: 'dsh', SUPPORT_STORE: 'postgres', SUPPORT_EXECUTION: 'worker', SUPPORT_CONFIG_FILE: 'missing-synthetic-config.json' },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = '', bytes = 0;
      const deadline = setTimeout(() => reject(new Error('Default local demo CLI did not become ready')), 20_000);
      const fail = () => { clearTimeout(deadline); reject(new Error('Default local demo CLI could not start')); };
      child.once('error', fail); child.once('exit', fail);
      child.stdout!.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 8192) { fail(); return; }
        stdout += chunk.toString();
        if (stdout.includes('Local demo API: http://127.0.0.1:8000')) { clearTimeout(deadline); resolve(); }
      });
      child.stderr!.on('data', chunk => { bytes += chunk.length; if (bytes > 8192) fail(); });
    });
    const denied = await read('/api/v1/operator/session');
    assert.equal(denied.status, 401); assert.equal(denied.cache, 'no-store');
    const valid = await read('/api/v1/operator/session', '1111');
    assert.equal(valid.status, 200); assert.deepEqual(valid.body, { authenticated: true });
    const ready = await read('/health/ready');
    assert.equal(ready.status, 200); assert.deepEqual(ready.body, { status: 'ok', dependencies: { memory: 'ok' } });
  } finally { await stop(child); }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Only the spawned demo child must be stopped');
});
