import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runCli, versionInfo } from '../src/cli/run.js';

async function temporary(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'eldhall-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function invoke(args: string[], environment: Partial<Pick<NodeJS.ProcessEnv, 'SUPPORT_CONFIG_FILE'>> = {}) {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await runCli(args, { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }, environment);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

// Synthetic contract fixture only: no image/digest/source publication is claimed.
function releaseFixture() {
  const hash = (value: string) => createHash('sha256').update(`cli-test:${value}`).digest('hex');
  const digest = (value: string) => `sha256:${hash(value)}`;
  const artifacts: { path: string; sha256: string; kind: string; subject?: { path: string; sha256: string } }[] = [];
  const artifact = (kind: string, path: string) => { const ref = { path, sha256: hash(path) }; artifacts.push({ ...ref, kind }); return ref; };
  const image = (name: string, roles: string[]) => ({ repository: `docker.io/latkonazar/eldhall-${name}`, tag: '0.1.0-rc.1', indexDigest: digest(`${name}-index`), roles,
    platforms: [{ platform: 'linux/amd64', manifestDigest: digest(name), baseImages: [{ repository: 'docker.io/library/base', digest: digest('base') }], sbom: artifact('sbom', `${name}.sbom`), provenance: artifact('provenance', `${name}.provenance`) }] });
  const server = image('server', ['api', 'worker', 'migrate']), web = image('web', ['web']), mcpOpenapi = image('mcp-openapi', ['mcp-server', 'mcp-import']);
  const bounds = { min: 0, max: 1 }, roles = { api: { read: bounds, write: bounds }, worker: { read: bounds, write: bounds }, migrate: { read: bounds, write: bounds } };
  const dependency = (name: string, major: number) => ({ repository: `docker.io/library/${name}`, indexDigest: digest(`${name}-index`), version: `${major}.1`, supportedMajorVersions: { min: major, max: major }, platforms: [{ platform: 'linux/amd64', manifestDigest: digest(name) }] });
  const license = { spdx: 'Apache-2.0', inventory: artifact('inventory', 'inventory.json'), notices: artifact('notices', 'NOTICE') };
  for (const kind of ['bundle', 'docs', 'openapi', 'signature']) artifact(kind, `${kind}.txt`);
  artifacts.find(value => value.kind === 'signature')!.subject = { path: 'bundle.txt', sha256: hash('bundle.txt') };
  const verification = { platforms: [{ platform: 'linux/amd64', execution: 'native', sourceCommit: 'a'.repeat(40), imageDigests: { server: digest('server'), web: digest('web'), mcpOpenapi: digest('mcp-openapi') }, report: artifact('test-report', 'native.json') }],
    installProfiles: ['headless', 'ui', 'openapi-sidecar', 'external-postgres'].map(id => ({ id, platform: 'linux/amd64', report: artifact('test-report', `${id}.json`) })) };
  return { manifestVersion: 1, release: { version: '0.1.0-rc.1', channel: 'prerelease', createdAt: '2026-11-04T00:00:00Z' },
    source: { repository: 'https://github.com/LatkoNazar/eldhall', commit: 'a'.repeat(40), tag: 'v0.1.0-rc.1', archive: { url: 'https://example.invalid/source.tar.gz', sha256: hash('source') } },
    license, images: { server, web, mcpOpenapi }, dependencies: { postgres: dependency('postgres', 17), redis: dependency('redis', 7) },
    compatibility: { schemas: ['starter', 'support'].map(id => ({ id, target: 1, roles, migration: { from: bounds, target: 1, fileSet: [{ path: `${id}.sql`, sha256: hash(id) }] } })),
      config: { infrastructure: { write: 1, read: bounds }, support: { write: 1, read: bounds } }, adapter: { openapi: { manifestSchema: bounds, contract: bounds } }, runtime: { id: 'dsh', packages: { '@deepseek-ai/dsh': '0.2.2-alpha.2' }, sessionFormat: bounds, topology: 'single-worker' } },
    artifacts, verification, provenance: { issuer: 'https://example.invalid/issuer', workflow: 'https://example.invalid/workflow', sourceCommit: 'a'.repeat(40), attestations: [server.platforms[0]!.provenance] } };
}

test('actual help/version process ignores dotenv, service configuration and runtime build overrides', async t => {
  const directory = await temporary(t);
  const packageVersion = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  await writeFile(join(directory, '.env'), 'ENVIRONMENT=private-invalid-dotenv\nDATABASE_URL=private-secret\n');
  for (const args of [['help'], ['version']]) {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)), ...args], {
      cwd: directory, encoding: 'utf8', timeout: 15_000, env: { ...process.env, ENVIRONMENT: 'private-invalid-environment', DATABASE_URL: 'private-invalid-url', ELDHALL_VERSION: 'private-runtime-override', ELDHALL_SOURCE_REVISION: 'private-runtime-revision' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /private-/);
    if (args[0] === 'version') assert.deepEqual(JSON.parse(result.stdout), { name: 'eldhall', version: packageVersion, packageVersion, sourceRevision: null, buildMetadata: 'unrecorded' });
    else { assert.match(result.stdout, /config validate/); assert.doesNotMatch(result.stdout, /eldhall (?:doctor|bootstrap)/); }
  }
});

test('strict command arguments distinguish usage errors from validation failures without reflecting argv', async () => {
  for (const args of [['private-command'], ['help', 'private-extra'], ['version', '--json'], ['config'], ['config', 'validate'], ['release', 'validate'], ['config', 'validate', '--file'], ['config', 'validate', '--file', 'x', '--file', 'y']]) {
    const result = await invoke(args);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private-|--json|\bx\b|\by\b/);
  }
  assert.equal((await invoke([])).code, 0);
});

test('static config validator shares runtime schema without requiring referenced connector secrets', async t => {
  const directory = await temporary(t), file = join(directory, 'private-config.json');
  await writeFile(file, await readFile(new URL('../../../examples/support.config.json', import.meta.url), 'utf8'));
  const result = await invoke(['config', 'validate'], { SUPPORT_CONFIG_FILE: file });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, kind: 'support-config', scope: 'static' });
  const override = join(directory, 'explicit.json'); await writeFile(override, '{}');
  assert.equal((await invoke(['config', 'validate', '--file', override], { SUPPORT_CONFIG_FILE: join(directory, 'absent') })).code, 0);
});

test('config validation redacts malformed JSON, unknown keys, invalid resources and filesystem errors', async t => {
  const directory = await temporary(t), file = join(directory, 'private-resource.json');
  for (const body of ['{"private-secret":', '{"private-secret":"private-token"}', '{"businesses":[{"id":"private-secret"}]}', 'x'.repeat(2_000_001)]) {
    await writeFile(file, body);
    const result = await invoke(['config', 'validate', '--file', file]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private-|token|resource\.json/);
  }
  for (const path of [directory, join(directory, 'private-missing')]) assert.equal((await invoke(['config', 'validate', '--file', path])).code, 1);
});

test('release validation uses actual strict semantic and duplicate-safe parser without claiming artifact verification', async t => {
  const directory = await temporary(t), file = join(directory, 'release.json');
  const candidate = releaseFixture(); await writeFile(file, JSON.stringify(candidate));
  const valid = await invoke(['release', 'validate', '--file', file]);
  assert.equal(valid.code, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), { valid: true, kind: 'release-manifest', scope: 'static' });
  for (const body of ['{"private-secret":', '{"private-secret":"private-token"}', JSON.stringify(candidate).replace('{', '{"manifestVersion":1,'), JSON.stringify({ ...candidate, source: { ...candidate.source, commit: 'private-invalid' } })]) {
    await writeFile(file, body);
    const result = await invoke(['release', 'validate', '--file', file]);
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.doesNotMatch(result.stderr, /private-|token|release\.json/);
  }
});

test('build writer records only explicit public args and version reads immutable build identity', async t => {
  const directory = await temporary(t);
  await mkdir(join(directory, 'scripts')); await writeFile(join(directory, 'package.json'), '{"version":"0.1.0"}');
  const writer = join(directory, 'scripts/write-build-info.mjs'); await copyFile(new URL('../scripts/write-build-info.mjs', import.meta.url), writer);
  const run = (args: string[]) => spawnSync(process.execPath, [writer, ...args], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELDHALL_VERSION: 'private-runtime', ELDHALL_SOURCE_REVISION: 'private-runtime' } });
  assert.equal(run([]).status, 0);
  const root = pathToFileURL(`${directory}/`), metadata = pathToFileURL(join(directory, 'dist/build-info.json'));
  assert.equal((await versionInfo(root, metadata)).sourceRevision, null);
  assert.equal(run(['--version', '0.1.0-rc.1', '--source-revision', 'b'.repeat(40)]).status, 0);
  assert.deepEqual(await versionInfo(root, metadata), { name: 'eldhall', version: '0.1.0-rc.1', packageVersion: '0.1.0', sourceRevision: 'b'.repeat(40), buildMetadata: 'recorded' });
  const bad = run(['--version', 'private-secret', '--source-revision', 'private-secret']);
  assert.equal(bad.status, 1); assert.doesNotMatch(bad.stderr + bad.stdout, /private-secret/);
  assert.equal((await versionInfo(root, metadata)).sourceRevision, 'b'.repeat(40));
  await writeFile(join(directory, 'dist/build-info.json'), '{"version":"private-secret"}');
  await assert.rejects(versionInfo(root, metadata), /Invalid build identity/);
});
