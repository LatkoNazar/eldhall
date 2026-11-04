import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { releaseManifestSchema, checkSchemaCompatibility, serverRoleImages, type ReleaseManifest } from '../src/release/manifest.js';
import { releaseManifestJsonSchema } from '../src/release/json-schema.js';
import { parseReleaseManifest } from '../src/release/parse.js';

// Synthetic metadata only: these hashes are not published images or release evidence.
const hash = (name: string) => createHash('sha256').update(`synthetic-test:${name}`).digest('hex');
const digest = (name: string) => `sha256:${hash(name)}`;
function candidate(): ReleaseManifest {
  const artifacts: ReleaseManifest['artifacts'] = [];
  const artifact = (kind: ReleaseManifest['artifacts'][number]['kind'], name: string) => {
    const ref = { path: `artifacts/${name}`, sha256: hash(name) };
    artifacts.push({ ...ref, kind });
    return ref;
  };
  const platforms = ['linux/amd64', 'linux/arm64'] as const;
  const image = (name: string, roles: string[]) => ({
    repository: `docker.io/latkonazar/eldhall-${name}`, tag: '0.1.0-rc.1', indexDigest: digest(`${name}/index`), roles,
    platforms: platforms.map(platform => ({ platform, manifestDigest: digest(`${name}/${platform}`), baseImages: [{ repository: 'docker.io/library/base', digest: digest(`${name}/base/${platform}`) }], sbom: artifact('sbom', `${name}-${platform.replace('/', '-')}.sbom.json`), provenance: artifact('provenance', `${name}-${platform.replace('/', '-')}.provenance.json`) })),
  });
  const server = image('server', ['api', 'worker', 'migrate']);
  const web = image('web', ['web']);
  const mcpOpenapi = image('mcp-openapi', ['mcp-server', 'mcp-import']);
  const sourceCommit = 'a'.repeat(40);
  const roleRange = () => ({ read: { min: 1, max: 1 }, write: { min: 1, max: 1 } });
  const schemas = (['starter', 'support'] as const).map(id => ({ id, target: 1, roles: { api: roleRange(), worker: roleRange(), migrate: { read: { min: 0, max: 1 }, write: { min: 0, max: 1 } } }, migration: { from: { min: 0, max: 1 }, target: 1, fileSet: [{ path: `migrations/${id}.sql`, sha256: hash(id) }] } }));
  const dependency = (name: string, major: number) => ({ repository: `docker.io/library/${name}`, indexDigest: digest(`${name}/index`), version: `${major}.1`, supportedMajorVersions: { min: major, max: major }, platforms: platforms.map(platform => ({ platform, manifestDigest: digest(`${name}/${platform}`) })) });
  const license = { spdx: 'Apache-2.0', inventory: artifact('inventory', 'inventory.json'), notices: artifact('notices', 'NOTICE') };
  for (const kind of ['bundle', 'docs', 'openapi', 'signature'] as const) artifact(kind, `${kind}.txt`);
  const verification = {
    platforms: platforms.map(platform => ({ platform, execution: 'native', sourceCommit, imageDigests: { server: digest(`server/${platform}`), web: digest(`web/${platform}`), mcpOpenapi: digest(`mcp-openapi/${platform}`) }, report: artifact('test-report', `native-${platform.replace('/', '-')}.json`) })),
    installProfiles: platforms.flatMap(platform => (['headless', 'ui', 'openapi-sidecar', 'external-postgres'] as const).map(id => ({ id, platform, report: artifact('test-report', `${id}-${platform.replace('/', '-')}.json`) }))),
  };
  return releaseManifestSchema.parse({
    manifestVersion: 1, release: { version: '0.1.0-rc.1', channel: 'prerelease', createdAt: '2026-11-04T00:00:00Z' },
    source: { repository: 'https://github.com/LatkoNazar/eldhall', commit: sourceCommit, tag: 'v0.1.0-rc.1', archive: { url: 'https://example.com/source.tar.gz', sha256: hash('source') } },
    license, images: { server, web, mcpOpenapi }, dependencies: { postgres: dependency('postgres', 16), redis: dependency('redis', 7) },
    compatibility: { schemas, config: { infrastructure: { write: 1, read: { min: 1, max: 1 } }, support: { write: 1, read: { min: 1, max: 1 } } }, adapter: { openapi: { manifestSchema: { min: 1, max: 1 }, contract: { min: 1, max: 1 } } }, runtime: { id: 'dsh', packages: { '@deepseek-ai/dsh': '0.2.2-alpha.2' }, sessionFormat: { min: 1, max: 1 }, topology: 'single-worker' } },
    artifacts, verification, provenance: { issuer: 'https://token.actions.githubusercontent.com', workflow: 'https://github.com/LatkoNazar/eldhall/.github/workflows/release.yml', sourceCommit, attestations: [server.platforms[0]!.provenance] },
  });
}

test('candidate keeps API, worker and migration on the same index and platform digest', () => {
  const manifest = candidate();
  assert.deepEqual(serverRoleImages(manifest, 'linux/arm64'), {
    api: { index: `docker.io/latkonazar/eldhall-server@${digest('server/index')}`, platform: `docker.io/latkonazar/eldhall-server@${digest('server/linux/arm64')}` },
    worker: { index: `docker.io/latkonazar/eldhall-server@${digest('server/index')}`, platform: `docker.io/latkonazar/eldhall-server@${digest('server/linux/arm64')}` },
    migrate: { index: `docker.io/latkonazar/eldhall-server@${digest('server/index')}`, platform: `docker.io/latkonazar/eldhall-server@${digest('server/linux/arm64')}` },
  });
  assert.equal(parseReleaseManifest(JSON.stringify(manifest)).source.commit, manifest.source.commit);
  assert.equal(releaseManifestSchema.safeParse({ ...manifest, images: { ...manifest.images, worker: manifest.images.server } }).success, false);
});

test('role images, release tag and prerelease policy cannot silently drift', () => {
  for (const version of ['latest', '0.1.0', '01.1.0-rc.1', '0.1.0-rc.01', '0.1.0+build-with-hyphen']) {
    const value = candidate(); value.release.version = version; value.source.tag = `v${version}`;
    for (const image of Object.values(value.images)) image.tag = version;
    assert.equal(releaseManifestSchema.safeParse(value).success, false, version);
  }
  const value = candidate(); Object.assign(value.images.server, { roles: ['worker', 'api', 'migrate'] });
  assert.equal(releaseManifestSchema.safeParse(value).success, false);
  value.images.server.roles = ['api', 'worker', 'migrate']; value.images.web.tag = '0.1.0-rc.2';
  assert.equal(releaseManifestSchema.safeParse(value).success, false);
});

test('source, digest level and native image coverage must match', () => {
  const changes: ((value: ReleaseManifest) => void)[] = [
    value => { value.source.commit = 'short'; },
    value => { value.source.archive.url = 'https://token:secret@example.com/source'; },
    value => { value.provenance.sourceCommit = 'b'.repeat(40); },
    value => { value.verification.platforms[0]!.sourceCommit = 'b'.repeat(40); },
    value => { value.images.server.indexDigest = value.images.server.platforms[0]!.manifestDigest; },
    value => { value.images.web.platforms.pop(); },
    value => { value.dependencies.postgres.platforms.pop(); },
    value => { value.verification.platforms[0]!.imageDigests.server = value.images.server.indexDigest; },
    value => { value.images.server.platforms[0]!.manifestDigest = 'sha256:' + 'A'.repeat(64); },
    value => { value.verification.platforms.push(value.verification.platforms[0]!); },
    value => { value.verification.installProfiles.pop(); },
  ];
  for (const mutate of changes) { const value = candidate(); mutate(value); assert.equal(releaseManifestSchema.safeParse(value).success, false); }
});

test('compatibility checks both bounds and both read/write access for every role', () => {
  const value = candidate();
  assert.deepEqual(checkSchemaCompatibility(value, 'api', { starter: 1, support: 1 }), []);
  assert.deepEqual(checkSchemaCompatibility(value, 'migrate', { starter: 0, support: 0 }), []);
  for (const role of ['api', 'worker', 'migrate'] as const) {
    const low = checkSchemaCompatibility(value, role, { starter: -1, support: -1 });
    const high = checkSchemaCompatibility(value, role, { starter: 2, support: 2 });
    for (const id of ['starter', 'support']) for (const access of ['read', 'write']) {
      assert.ok(low.includes(`${id}.${role}.${access}`)); assert.ok(high.includes(`${id}.${role}.${access}`));
    }
  }
  const writeOnly = candidate(); writeOnly.compatibility.schemas[0]!.roles.api.read.max = 2;
  assert.deepEqual(checkSchemaCompatibility(writeOnly, 'api', { starter: 2, support: 1 }), ['starter.api.write']);
  assert.ok(checkSchemaCompatibility(value, 'worker', { starter: Number.NaN, support: 1 }).includes('starter.worker.read'));
});

test('inverted ranges, incompatible producer versions and unbounded migrations fail', () => {
  const changes: ((value: ReleaseManifest) => void)[] = [
    value => { value.compatibility.schemas[0]!.roles.api.read = { min: 2, max: 1 }; },
    value => { value.compatibility.schemas[0]!.roles.worker.write.max = 0; },
    value => { value.compatibility.schemas[0]!.migration.from.max = 2; },
    value => { value.compatibility.schemas[0]!.migration.target = 2; },
    value => { value.compatibility.config.support.write = 2; },
    value => { value.compatibility.adapter.openapi.contract = { min: 2, max: 1 }; },
    value => { value.compatibility.runtime.sessionFormat = { min: 2, max: 1 }; },
    value => { value.compatibility.runtime.packages = {}; },
    value => { value.dependencies.redis.supportedMajorVersions.min = 8; },
    value => { value.compatibility.schemas[1]!.id = 'starter'; },
  ];
  for (const mutate of changes) { const value = candidate(); mutate(value); assert.equal(releaseManifestSchema.safeParse(value).success, false); }
});

test('artifact and migration paths remain normalized and checksum-bound', () => {
  for (const unsafe of ['../migration.sql', '/migration.sql', 'migrations/../migration.sql', 'migrations/./migration.sql', 'migrations//migration.sql', 'C:\\migration.sql', 'migrations\\migration.sql', 'migrations/a%2fb.sql']) {
    const value = candidate(); value.compatibility.schemas[0]!.migration.fileSet[0]!.path = unsafe;
    assert.equal(releaseManifestSchema.safeParse(value).success, false, unsafe);
  }
  for (const mutate of [
    (value: ReleaseManifest) => value.artifacts.push(value.artifacts[0]!),
    (value: ReleaseManifest) => { value.license.inventory.sha256 = hash('changed'); },
    (value: ReleaseManifest) => { value.compatibility.schemas[0]!.migration.fileSet[0]!.sha256 = 'A'.repeat(64); },
    (value: ReleaseManifest) => value.compatibility.schemas[0]!.migration.fileSet.push(value.compatibility.schemas[0]!.migration.fileSet[0]!),
  ]) { const value = candidate(); mutate(value); assert.equal(releaseManifestSchema.safeParse(value).success, false); }
});

test('strict JSON parsing rejects duplicate escaped keys and redacts malformed input', () => {
  const serialized = JSON.stringify(candidate());
  assert.throws(() => parseReleaseManifest(serialized.replace('"manifestVersion":1', '"manifestVersion":1,"manifest\\u0056ersion":1')), /duplicate JSON key/);
  assert.throws(() => parseReleaseManifest('{"password":"secret",broken'), error => error instanceof Error && error.message === 'Release manifest is not valid JSON');
  assert.throws(() => parseReleaseManifest(JSON.stringify({ ...candidate(), unexpected: true })));
  assert.throws(() => parseReleaseManifest(' '.repeat(4_000_001)), /size limit/);
});

test('checked-in structural JSON Schema is deterministic, strict and separate from semantic checks', async () => {
  const generated = releaseManifestJsonSchema();
  assert.equal(generated, releaseManifestJsonSchema());
  assert.equal(generated, await readFile(new URL('../../../schemas/release-manifest.v1.schema.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(generated) as { additionalProperties: boolean; properties: { images: { additionalProperties: boolean } }; 'x-eldhall-semantic-validator': string };
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.images.additionalProperties, false);
  assert.match(schema['x-eldhall-semantic-validator'], /releaseManifestSchema$/);
});
