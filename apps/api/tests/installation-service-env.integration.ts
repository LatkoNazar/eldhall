import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeComposeEnvironment } from '../src/installation/env.js';

// Mandatory explicit Linux-engine lane; never included in ordinary npm test.
test('actual isolated Compose service receives literal generated environment values', { timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'eldhall-service-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = `eldhall-env-${randomUUID().replaceAll('-', '')}`;
  const values = Object.fromEntries(['', '  padded # value  ', '$HOME ${NOT_SELECTED}', '$$ $', '#hash', '\\', 'tail\\', "both'\"quotes", "slash\\'quote\"$#", '\\$literal \\${NOT_SELECTED}', '\\\\$\\', 'Привіт 🏦'].map((value, index) => [`CASE_${index}`, value]));
  const expected = Buffer.from(JSON.stringify(values)).toString('base64');
  // Base64 carries expected literals without dollar signs in the Compose model.
  // Never print environment values, including on assertion failure.
  const program = `const expected=JSON.parse(Buffer.from('${expected}','base64'));if(process.platform!=='linux'||process.getuid()!==1000||Object.entries(expected).some(([key,value])=>process.env[key]!==value))process.exit(1);process.stdout.write(JSON.stringify({valid:true,proof:'compose-service-literals',cases:Object.keys(expected).length}));`;
  const env = join(root, 'support.env'), compose = join(root, 'compose.json');
  await writeFile(env, encodeComposeEnvironment(values), { mode: 0o600 });
  await writeFile(compose, JSON.stringify({ services: { probe: { image: 'node:24.22.2-bookworm-slim', user: '1000:1000', network_mode: 'none', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], command: ['node', '--input-type=module', '--eval', program], environment: Object.fromEntries(Object.keys(values).map(key => [key, `\u0024{${key}}`])) } } }));
  const systemNames = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ProgramFiles', 'ProgramData', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'TEMP', 'TMP', 'HOME'];
  const controlled: NodeJS.ProcessEnv = { NOT_SELECTED: 'expansion-would-be-a-bug' };
  for (const name of systemNames) if (process.env[name] !== undefined) controlled[name] = process.env[name];
  const base = ['compose', '--project-name', project, '--env-file', env, '-f', compose];
  try {
    const result = spawnSync('docker', [...base, 'run', '--rm', '--no-deps', '-T', 'probe'], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1_048_576, env: controlled });
    assert.equal(result.status, 0, 'Actual Docker Compose service literal proof failed; Linux Docker engine is mandatory');
    let summary: unknown;
    try { summary = JSON.parse(result.stdout); } catch { assert.fail('Service returned no valid bounded proof summary'); }
    assert.ok(JSON.stringify(summary) === JSON.stringify({ valid: true, proof: 'compose-service-literals', cases: Object.keys(values).length }), 'Service literal proof summary differs');
  } finally {
    const cleanup = spawnSync('docker', [...base, 'down', '--remove-orphans', '--timeout', '10'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576, env: controlled });
    assert.equal(cleanup.status, 0, 'Scoped Compose proof cleanup failed');
  }
});
