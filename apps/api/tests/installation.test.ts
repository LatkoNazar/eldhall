import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initRequestSchema, installationSchema, type InitRequest } from '../src/installation/contracts.js';
import { decodeGeneratedEnvironment, encodeComposeEnvironment } from '../src/installation/env.js';
import { initializeOffline } from '../src/installation/filesystem.js';
import { InstallationFailure, loadInitRequest, prepareInstallation } from '../src/installation/prepare.js';
import { supportConfigSchema } from '../src/integrations/config.js';
import { runCli } from '../src/cli/run.js';

const by = { version: '0.1.0', packageVersion: '0.1.0', sourceRevision: null };
const evaluation: InitRequest = { initRequestFormat: 1, project: 'abcdefghijklmno-p', mode: 'evaluation', database: { mode: 'bundled' }, provider: { id: 'rules' } };
async function temporary(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'eldhall-installation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const failure = (reason: InstallationFailure['reason']) => (error: unknown) => error instanceof InstallationFailure && error.reason === reason;
async function snapshot(directory: string) {
  const files: Record<string, { content: string; modified: number; mode: number }> = {};
  for (const name of await readdir(directory)) {
    const file = join(directory, name), metadata = await lstat(file);
    files[name] = { content: await readFile(file, 'utf8'), modified: metadata.mtimeMs, mode: metadata.mode & 0o777 };
  }
  return files;
}

test('preparation is persistent, empty and honestly unbound with independent prospective namespaces', async () => {
  const first = await prepareInstallation(evaluation, by, { GEMINI_API_KEY: 'ambient-must-not-be-imported', DATABASE_URL: 'ambient-must-not-be-imported' });
  const second = await prepareInstallation(evaluation, by, {});
  assert.equal(first.identity.state, 'prepared');
  assert.deepEqual(first.identity.releaseBinding, { status: 'unbound', manifest: null });
  assert.notEqual(first.identity.installationId, second.identity.installationId);
  assert.notEqual(first.identity.projectName, second.identity.projectName);
  assert.notEqual(first.values.BULLMQ_PREFIX, second.values.BULLMQ_PREFIX);
  assert.match(first.identity.projectName, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(first.values.ENVIRONMENT, 'production'); assert.equal(first.values.SUPPORT_STORE, 'postgres'); assert.equal(first.values.SUPPORT_EXECUTION, 'worker'); assert.equal(first.values.DEMO_RESET_ENABLED, 'false');
  assert.equal(first.values.LLM_PROVIDER, 'rules'); assert.equal(first.values.AGENT_RUNTIME, 'rules');
  assert.equal(Object.hasOwn(first.values, 'GEMINI_API_KEY'), false); assert.equal(Object.hasOwn(first.values, 'DATABASE_URL'), false);
  for (const key of ['API_TOKEN', 'OPERATOR_TOKEN', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD']) assert.match(first.values[key]!, /^[a-f0-9]{64}$/);
  const support = supportConfigSchema.parse(JSON.parse(first.support));
  for (const key of ['businesses', 'knowledge', 'skills', 'integrations', 'catalogs'] as const) assert.equal(support[key].length, 0);
  assert.equal(installationSchema.safeParse({ ...first.identity, state: 'ready' }).success, false);
  assert.equal(installationSchema.safeParse({ ...first.identity, installationFormat: 2 }).success, false);
  assert.equal(installationSchema.safeParse({ ...first.identity, databaseEpoch: 1 }).success, false);
});

test('explicit provider/database sources preserve literals and ambient values never fill missing selections', async t => {
  const root = await temporary(t), key = join(root, 'provider-key');
  const literal = 'synthetic-API-ключ$#\\\'"with spaces\\';
  await writeFile(key, literal);
  const request: InitRequest = { ...evaluation, mode: 'production', database: { mode: 'external', url: { env: 'CHOSEN_DATABASE' } }, provider: { id: 'google', model: 'explicit-model', key: { file: key } } };
  const url = 'postgresql://user:p%24%23%27%22%D1%8F@db.example.invalid:5432/app?sslmode=verify-full';
  const prepared = await prepareInstallation(request, by, { CHOSEN_DATABASE: url, DATABASE_URL: 'ambient-ignored', GEMINI_API_KEY: 'ambient-ignored' });
  assert.equal(prepared.values.GEMINI_API_KEY, literal); assert.equal(prepared.values.DATABASE_URL, url);
  assert.equal(Object.hasOwn(prepared.values, 'POSTGRES_PASSWORD'), false); assert.equal(prepared.identity.plannedResources.postgresVolume, null);
  assert.equal(JSON.stringify(prepared.identity).includes(literal), false); assert.equal(JSON.stringify(prepared.identity).includes(url), false);
  const explicit: InitRequest = { ...evaluation, mode: 'production', provider: { id: 'openai', model: 'explicit-model', key: { env: 'SELECTED_KEY' } } };
  await assert.rejects(prepareInstallation(explicit, by, { OPENAI_API_KEY: 'not-an-opt-in' }), failure('invalid_input_source'));
  assert.equal((await prepareInstallation(explicit, by, { SELECTED_KEY: literal })).values.OPENAI_API_KEY, literal);
  assert.equal(initRequestSchema.safeParse({ ...explicit, provider: { id: 'openai', model: 'm', key: { value: 'inline-secret' } } }).success, false);
  assert.equal(initRequestSchema.safeParse({ ...explicit, provider: { id: 'local', model: 'm', baseUrl: 'https://example.invalid/?token=hidden' } }).success, false);
});

test('unsupported controls, multiline, surrogates, malformed and duplicate requests fail before any output directory', async t => {
  const root = await temporary(t), file = join(root, 'request.json'), output = join(root, 'must-not-exist');
  const request: InitRequest = { ...evaluation, mode: 'production', provider: { id: 'google', model: 'm', key: { env: 'SELECTED_KEY' } } };
  for (const value of ['a\nb', 'a\rb', 'a\0b', 'a\u007fb', 'a\u2028b', 'a\ud800b']) await assert.rejects(prepareInstallation(request, by, { SELECTED_KEY: value }), failure('invalid_input_source'));
  for (const content of ['{"private-secret":', '{"initRequestFormat":1,"initRequestFormat":2}', '{"project":"a","\\u0070roject":"b"}', 'x'.repeat(65_537)]) {
    await writeFile(file, content);
    const stdout: string[] = [], stderr: string[] = [];
    const result = await runCli(['init', '--directory', output, '--request-file', file], { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }, {});
    assert.equal(result, 1); assert.equal(stdout.length, 0); assert.doesNotMatch(stderr.join(), /private-secret|request\.json/);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
  await writeFile(file, JSON.stringify(evaluation)); assert.equal((await loadInitRequest(file)).mode, 'evaluation');
  const messages: string[] = [];
  assert.equal(await runCli(['init', '--directory', output, '--request-file', file, '--key', 'private-secret'], { stdout: value => messages.push(value), stderr: value => messages.push(value) }), 2);
  assert.doesNotMatch(messages.join(), /private-secret/);
});

test('canonical Compose-only codec preserves literals and rejects noncanonical state', () => {
  const cases = ['', '  padded # value  ', '$HOME ${NOT_SELECTED}', '$$ $', '#hash', '\\', 'tail\\', "both'\"quotes", "slash\\'quote\"$#", '\\$literal \\${NOT_SELECTED}', '\\\\$\\', 'Привіт 🏦'];
  const values = Object.fromEntries(cases.map((value, index) => [`CASE_${index}`, value]));
  const encoded = encodeComposeEnvironment(values); assert.deepEqual(decodeGeneratedEnvironment(encoded), values);
  assert.throws(() => decodeGeneratedEnvironment(encoded + 'CASE_0="other"\n'));
});

test('real filesystem preparation/repeat preserves bytes, keys, UUID and mtimes; unsupported native privacy is explicit', async t => {
  const root = await temporary(t), destination = join(root, 'new installation');
  const first = await prepareInstallation(evaluation, by, {});
  if (process.platform !== 'linux') {
    await assert.rejects(initializeOffline(destination, first), failure('unsupported_private_filesystem'));
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
    t.diagnostic('Native Windows/macOS refusal verified; positive private filesystem/replay proof requires actual Linux CI.');
    return;
  }
  const created = await initializeOffline(destination, first); assert.equal(created.status, 'created');
  assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  const before = await snapshot(destination); for (const file of Object.values(before)) assert.equal(file.mode, 0o600);
  const requestFile = join(root, 'request.json'); await writeFile(requestFile, JSON.stringify(evaluation));
  const stdout: string[] = [], stderr: string[] = [];
  assert.equal(await runCli(['init', '--directory', destination, '--request-file', requestFile], { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }, {}), 0);
  assert.deepEqual(JSON.parse(stdout[0]!), { status: 'reused', state: 'prepared', releaseBinding: 'unbound', files: ['support.env', 'support.json', 'installation.json'] });
  assert.deepEqual(stderr, []); assert.deepEqual(await snapshot(destination), before);
  const repeated = await initializeOffline(destination, await prepareInstallation(evaluation, { ...by, version: '0.1.1' }, {}));
  assert.equal(repeated.status, 'reused'); assert.equal(repeated.identity.installationId, created.identity.installationId);
  assert.deepEqual(await snapshot(destination), before);
  await assert.rejects(initializeOffline(destination, await prepareInstallation({ ...evaluation, project: 'different' }, by, {})), failure('incomplete_or_conflicting_installation'));
  assert.deepEqual(await snapshot(destination), before);
  await chmod(destination, 0o755);
  await assert.rejects(initializeOffline(destination, first), failure('private_permissions_required'));
  assert.equal((await lstat(destination)).mode & 0o777, 0o755);
  const production: InitRequest = { ...evaluation, mode: 'production', provider: { id: 'openai', model: 'explicit-model', key: { env: 'SELECTED_KEY' } } };
  const productionDirectory = join(root, 'production');
  await initializeOffline(productionDirectory, await prepareInstallation(production, by, { SELECTED_KEY: 'synthetic-original-key' }));
  const productionBefore = await snapshot(productionDirectory);
  await assert.rejects(initializeOffline(productionDirectory, await prepareInstallation(production, by, { SELECTED_KEY: 'synthetic-replacement-key' })), failure('incomplete_or_conflicting_installation'));
  assert.deepEqual(await snapshot(productionDirectory), productionBefore);
});

test('real Linux partial/symlink/racing preparations never overwrite existing paths or silently rotate state', async t => {
  const root = await temporary(t), first = await prepareInstallation(evaluation, by, {});
  if (process.platform !== 'linux') {
    await assert.rejects(initializeOffline(join(root, 'unsupported'), first), failure('unsupported_private_filesystem'));
    t.diagnostic('Linux-only no-follow/exclusive publication remains a required real Linux CI gate.'); return;
  }
  const partial = join(root, 'partial'); await mkdir(partial, { mode: 0o700 }); await writeFile(join(partial, 'support.env'), 'sentinel', { mode: 0o600 });
  await assert.rejects(initializeOffline(partial, first), failure('incomplete_or_conflicting_installation'));
  assert.equal(await readFile(join(partial, 'support.env'), 'utf8'), 'sentinel'); assert.deepEqual(await readdir(partial), ['support.env']);
  const outside = join(root, 'outside'); await mkdir(outside, { mode: 0o700 }); await writeFile(join(outside, 'sentinel'), 'unchanged');
  const linked = join(root, 'link'); await symlink(outside, linked, 'dir');
  await assert.rejects(initializeOffline(linked, first)); await assert.rejects(initializeOffline(join(linked, 'child'), first));
  assert.deepEqual(await readdir(outside), ['sentinel']);
  const race = join(root, 'race');
  const candidates = await Promise.all(Array.from({ length: 8 }, () => prepareInstallation(evaluation, by, {})));
  const results = await Promise.allSettled(candidates.map(candidate => initializeOffline(race, candidate)));
  assert.equal(results.filter(value => value.status === 'fulfilled' && value.value.status === 'created').length, 1);
  const identity = installationSchema.parse(JSON.parse(await readFile(join(race, 'installation.json'), 'utf8')));
  for (const result of results) if (result.status === 'fulfilled') assert.equal(result.value.identity.installationId, identity.installationId);
  const before = await snapshot(race); await unlink(join(race, 'support.env')); await symlink(join(outside, 'sentinel'), join(race, 'support.env'));
  await assert.rejects(initializeOffline(race, first)); assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'unchanged');
  assert.equal(await readFile(join(race, 'installation.json'), 'utf8'), before['installation.json']!.content);
});
