import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const secrets = { POSTGRES_PASSWORD: 'p-secret-'.repeat(4), REDIS_PASSWORD: 'r-secret-'.repeat(4), API_TOKEN: 'api-secret-'.repeat(4), OPERATOR_TOKEN: 'op-secret-'.repeat(4) };

// Run from an empty directory: loadEnvironment() reads .env files from the working directory upwards,
// so a developer's .env cannot change the outcome. Only the variables below reach the child.
const cwd = mkdtempSync(`${tmpdir()}/startup-config-`);
after(() => rmSync(cwd, { recursive: true, force: true }));
const tsx = import.meta.resolve('tsx');
const source = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));

/** Real process start: the operator must see why production refused to start, never the secret values. */
function start(entry: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, source(entry)], {
      cwd,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('production API, worker and migrations refuse demo-shaped configuration with the reason and no secret values', async () => {
  const production = { ENVIRONMENT: 'production', ALLOWED_HOSTS: '["api.example.com"]', ...secrets };
  for (const [entry, prefix] of [['server.ts', /API configuration invalid: /], ['worker.ts', /Worker configuration invalid: /], ['migrate.ts', /^/m]] as const) {
    for (const [env, reason] of [
      [{ ...production, SUPPORT_STORE: 'memory' }, /SUPPORT_STORE=postgres/],
      [{ ...production, SUPPORT_STORE: 'postgres', DEMO_RESET_ENABLED: 'true' }, /DEMO_RESET_ENABLED must be off/],
      [{ ...production, SUPPORT_STORE: 'postgres', LLM_PROVIDER: 'google', GEMINI_API_KEY: 'gemini-secret-value' }, /Production DSH requires RUNTIME_HOME/],
    ] as const) {
      const result = await start(entry, env);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, prefix);
      assert.match(result.output, reason);
      for (const value of [...Object.values(secrets), 'gemini-secret-value']) assert.equal(result.output.includes(value), false, `${entry} leaked a secret`);
    }
  }
});
