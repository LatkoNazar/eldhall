import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeComposeEnvironment } from '../src/installation/env.js';

// Explicit interoperability lane: absence of Docker Compose is a failure,
// never a skip. The ordinary API unit suite has no Docker prerequisite.
test('real Docker Compose parser preserves quote, slash, interpolation and Unicode literals', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eldhall-compose-codec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = ['', '  padded # value  ', '$HOME ${NOT_SELECTED}', '$$ $', '#hash', '\\', 'tail\\', "both'\"quotes", "slash\\'quote\"$#", '\\$literal \\${NOT_SELECTED}', '\\\\$\\', 'Привіт 🏦'];
  const values = Object.fromEntries(cases.map((value, index) => [`CASE_${index}`, value]));
  const env = join(root, 'support.env'), compose = join(root, 'compose.yaml');
  await writeFile(env, encodeComposeEnvironment(values));
  await writeFile(compose, 'name: synthetic-codec\nservices:\n  probe:\n    image: scratch\n    environment:\n' + Object.keys(values).map(key => `      ${key}: \u0024{${key}}\n`).join(''));
  // --environment exposes the actual dotenv decoding. `config --format json`
  // re-escapes dollar signs in its serializable Compose model; do not collapse
  // arbitrary $$ strings heuristically. Inspect only our synthetic CASE_* keys.
  const systemNames = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ProgramFiles', 'ProgramData', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'TEMP', 'TMP', 'HOME'];
  const controlled: NodeJS.ProcessEnv = { NOT_SELECTED: 'expansion-would-be-a-bug' };
  for (const name of systemNames) if (process.env[name] !== undefined) controlled[name] = process.env[name];
  const result = spawnSync('docker', ['compose', '--env-file', env, '-f', compose, 'config', '--environment'], { encoding: 'utf8', timeout: 20_000, env: controlled });
  assert.equal(result.status, 0, 'A real Docker Compose CLI is required for literal compatibility proof');
  const decoded = Object.fromEntries(result.stdout.split(/\r?\n/).filter(line => /^CASE_\d+=/.test(line)).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
  assert.deepEqual(decoded, values);
});
