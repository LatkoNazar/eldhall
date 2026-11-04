import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const semver = z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/);
const releaseVersion = semver.refine(value => !value.includes('+'), 'Release versions omit build metadata to remain Docker tags');
const httpsUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, 'Expected public HTTPS URL without credentials or fragment');
const path = z.string().min(1).max(300).regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine(value => value.split('/').every(segment => segment !== '.' && segment !== '..'), 'Expected normalized relative artifact path');
const platform = z.enum(['linux/amd64', 'linux/arm64']);
const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ min: epoch, max: epoch });
const reference = z.strictObject({ path, sha256 });
const baseImage = z.strictObject({ repository: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/), digest });
const imagePlatform = z.strictObject({ platform, manifestDigest: digest, baseImages: z.array(baseImage).min(1).max(20), sbom: reference, provenance: reference });
const image = <T extends z.ZodType>(repository: string, roles: T) => z.strictObject({ repository: z.literal(repository), tag: releaseVersion, indexDigest: digest, roles, platforms: z.array(imagePlatform).min(1).max(2) });
const dependency = (repository: string) => z.strictObject({
  repository: z.literal(repository), indexDigest: digest,
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/),
  supportedMajorVersions: range,
  platforms: z.array(z.strictObject({ platform, manifestDigest: digest })).min(1).max(2),
});
const roleRanges = z.strictObject({ read: range, write: range });
const schema = z.strictObject({
  id: z.enum(['starter', 'support']), target: epoch,
  roles: z.strictObject({ api: roleRanges, worker: roleRanges, migrate: roleRanges }),
  migration: z.strictObject({ from: range, target: epoch, fileSet: z.array(reference).min(1).max(1000) }),
});
const config = z.strictObject({ write: epoch, read: range });

/** Structural source of truth. JSON Schema cannot express all cross-field checks below. */
export const releaseManifestStructure = z.strictObject({
  manifestVersion: z.literal(1),
  release: z.strictObject({ version: releaseVersion, channel: z.literal('prerelease'), createdAt: z.iso.datetime() }),
  source: z.strictObject({ repository: z.literal('https://github.com/LatkoNazar/eldhall'), commit, tag: z.string(), archive: z.strictObject({ url: httpsUrl, sha256 }) }),
  license: z.strictObject({ spdx: z.literal('Apache-2.0'), inventory: reference, notices: reference }),
  images: z.strictObject({
    server: image('docker.io/latkonazar/eldhall-server', z.tuple([z.literal('api'), z.literal('worker'), z.literal('migrate')])),
    web: image('docker.io/latkonazar/eldhall-web', z.tuple([z.literal('web')])),
    mcpOpenapi: image('docker.io/latkonazar/eldhall-mcp-openapi', z.tuple([z.literal('mcp-server'), z.literal('mcp-import')])),
  }),
  dependencies: z.strictObject({ postgres: dependency('docker.io/library/postgres'), redis: dependency('docker.io/library/redis') }),
  compatibility: z.strictObject({
    schemas: z.array(schema).length(2),
    config: z.strictObject({ infrastructure: config, support: config }),
    adapter: z.strictObject({ openapi: z.strictObject({ manifestSchema: range, contract: range }) }),
    runtime: z.strictObject({ id: z.literal('dsh'), packages: z.record(z.string().regex(/^@deepseek-ai\/dsh(?:-[a-z-]+)?$/), semver), sessionFormat: range, topology: z.literal('single-worker') }),
  }),
  artifacts: z.array(z.strictObject({ path, sha256, kind: z.enum(['bundle', 'docs', 'openapi', 'sbom', 'notices', 'inventory', 'provenance', 'test-report', 'signature']) })).min(1).max(5000),
  verification: z.strictObject({
    platforms: z.array(z.strictObject({ platform, execution: z.literal('native'), sourceCommit: commit, imageDigests: z.strictObject({ server: digest, web: digest, mcpOpenapi: digest }), report: reference })).min(1).max(2),
    installProfiles: z.array(z.strictObject({ id: z.enum(['headless', 'ui', 'openapi-sidecar', 'external-postgres']), platform, report: reference })).min(1).max(8),
  }),
  provenance: z.strictObject({ issuer: httpsUrl, workflow: httpsUrl, sourceCommit: commit, attestations: z.array(reference).min(1).max(100) }),
});
export type ReleaseManifest = z.infer<typeof releaseManifestStructure>;
export type ReleaseRole = 'api' | 'worker' | 'migrate';
type Range = z.infer<typeof range>;
const contains = (bounds: Range, value: number) => value >= bounds.min && value <= bounds.max;

export const releaseManifestSchema = releaseManifestStructure.superRefine((manifest, context) => {
  const issue = (at: (string | number)[], message: string) => context.addIssue({ code: 'custom', path: at, message });
  const unique = <T>(values: T[], key: (value: T) => string, at: (string | number)[]) => {
    if (new Set(values.map(key)).size !== values.length) issue(at, 'Duplicate identity');
  };
  const checkRange = (value: Range, at: (string | number)[]) => { if (value.min > value.max) issue(at, 'Minimum exceeds maximum'); };
  if (!/^\d+\.\d+\.\d+-/.test(manifest.release.version)) issue(['release', 'version'], 'Prerelease channel requires a prerelease version');
  if (manifest.source.tag !== `v${manifest.release.version}`) issue(['source', 'tag'], 'Source tag must identify the release version');
  if (manifest.provenance.sourceCommit !== manifest.source.commit) issue(['provenance', 'sourceCommit'], 'Provenance source differs from release source');

  const artifacts = new Map(manifest.artifacts.map(artifact => [artifact.path, artifact]));
  unique(manifest.artifacts, value => value.path, ['artifacts']);
  const requireRef = (ref: z.infer<typeof reference>, at: (string | number)[], kind?: ReleaseManifest['artifacts'][number]['kind']) => {
    const artifact = artifacts.get(ref.path);
    if (!artifact || artifact.sha256 !== ref.sha256 || (kind && artifact.kind !== kind)) issue(at, 'Artifact reference is absent, mismatched or has the wrong kind');
  };
  requireRef(manifest.license.inventory, ['license', 'inventory'], 'inventory');
  requireRef(manifest.license.notices, ['license', 'notices'], 'notices');
  manifest.provenance.attestations.forEach((ref, index) => requireRef(ref, ['provenance', 'attestations', index], 'provenance'));
  unique(manifest.provenance.attestations, value => value.path, ['provenance', 'attestations']);
  for (const kind of ['bundle', 'docs', 'openapi', 'sbom', 'notices', 'inventory', 'provenance', 'test-report', 'signature'] as const) {
    if (!manifest.artifacts.some(artifact => artifact.kind === kind)) issue(['artifacts'], `Missing ${kind} artifact`);
  }

  const expectedPlatforms = manifest.images.server.platforms.map(entry => entry.platform).sort();
  for (const [key, record] of Object.entries(manifest.images)) {
    const at = ['images', key];
    if (record.tag !== manifest.release.version) issue([...at, 'tag'], 'Image tag differs from release version');
    unique(record.platforms, value => value.platform, [...at, 'platforms']);
    const actual = record.platforms.map(entry => entry.platform).sort();
    if (actual.join() !== expectedPlatforms.join()) issue([...at, 'platforms'], 'Image platform coverage differs');
    record.platforms.forEach((entry, index) => {
      if (entry.manifestDigest === record.indexDigest) issue([...at, 'platforms', index, 'manifestDigest'], 'Index and platform manifest are different objects');
      unique(entry.baseImages, value => `${value.repository}@${value.digest}`, [...at, 'platforms', index, 'baseImages']);
      requireRef(entry.sbom, [...at, 'platforms', index, 'sbom'], 'sbom');
      requireRef(entry.provenance, [...at, 'platforms', index, 'provenance'], 'provenance');
    });
  }
  for (const [key, record] of Object.entries(manifest.dependencies)) {
    const at = ['dependencies', key];
    checkRange(record.supportedMajorVersions, [...at, 'supportedMajorVersions']);
    if (!contains(record.supportedMajorVersions, Number(record.version.split('.')[0]))) issue([...at, 'version'], 'Dependency version outside supported major range');
    unique(record.platforms, value => value.platform, [...at, 'platforms']);
    if (record.platforms.map(entry => entry.platform).sort().join() !== expectedPlatforms.join()) issue([...at, 'platforms'], 'Dependency platform coverage differs');
    record.platforms.forEach((entry, index) => {
      if (entry.manifestDigest === record.indexDigest) issue([...at, 'platforms', index, 'manifestDigest'], 'Index and platform manifest are different objects');
    });
  }

  unique(manifest.compatibility.schemas, value => value.id, ['compatibility', 'schemas']);
  manifest.compatibility.schemas.forEach((entry, index) => {
    const at = ['compatibility', 'schemas', index];
    if (entry.target !== entry.migration.target) issue([...at, 'migration', 'target'], 'Migration target differs from schema target');
    checkRange(entry.migration.from, [...at, 'migration', 'from']);
    unique(entry.migration.fileSet, value => value.path, [...at, 'migration', 'fileSet']);
    for (const [role, bounds] of Object.entries(entry.roles)) for (const access of ['read', 'write'] as const) {
      checkRange(bounds[access], [...at, 'roles', role, access]);
      if (!contains(bounds[access], entry.target)) issue([...at, 'roles', role, access], 'Target schema outside role compatibility');
      if (role === 'migrate' && (!contains(bounds[access], entry.migration.from.min) || !contains(bounds[access], entry.migration.from.max))) issue([...at, 'roles', role, access], 'Migration source range outside migrate compatibility');
    }
  });
  for (const [key, value] of Object.entries(manifest.compatibility.config)) {
    checkRange(value.read, ['compatibility', 'config', key, 'read']);
    if (!contains(value.read, value.write)) issue(['compatibility', 'config', key], 'Produced configuration is not readable');
  }
  for (const [key, value] of Object.entries(manifest.compatibility.adapter.openapi)) checkRange(value, ['compatibility', 'adapter', 'openapi', key]);
  checkRange(manifest.compatibility.runtime.sessionFormat, ['compatibility', 'runtime', 'sessionFormat']);
  if (!Object.hasOwn(manifest.compatibility.runtime.packages, '@deepseek-ai/dsh')) issue(['compatibility', 'runtime', 'packages'], 'Core runtime package is required');

  unique(manifest.verification.platforms, value => value.platform, ['verification', 'platforms']);
  if (manifest.verification.platforms.map(entry => entry.platform).sort().join() !== expectedPlatforms.join()) issue(['verification', 'platforms'], 'Native verification coverage differs');
  manifest.verification.platforms.forEach((entry, index) => {
    if (entry.sourceCommit !== manifest.source.commit) issue(['verification', 'platforms', index, 'sourceCommit'], 'Verification source differs');
    for (const key of ['server', 'web', 'mcpOpenapi'] as const) {
      if (entry.imageDigests[key] !== manifest.images[key].platforms.find(image => image.platform === entry.platform)?.manifestDigest) issue(['verification', 'platforms', index, 'imageDigests', key], 'Verification must name the exact platform image');
    }
    requireRef(entry.report, ['verification', 'platforms', index, 'report'], 'test-report');
  });
  unique(manifest.verification.installProfiles, value => `${value.id}/${value.platform}`, ['verification', 'installProfiles']);
  manifest.verification.installProfiles.forEach((entry, index) => {
    if (!expectedPlatforms.includes(entry.platform)) issue(['verification', 'installProfiles', index, 'platform'], 'Install report names an unsupported platform');
    requireRef(entry.report, ['verification', 'installProfiles', index, 'report'], 'test-report');
  });
  for (const supported of expectedPlatforms) for (const id of ['headless', 'ui', 'openapi-sidecar', 'external-postgres']) {
    if (!manifest.verification.installProfiles.some(entry => entry.platform === supported && entry.id === id)) issue(['verification', 'installProfiles'], 'Missing required install profile verification');
  }
});

/** Pure checks of observed versions, without database discovery, writes or startup enforcement. */
export function checkSchemaCompatibility(manifest: ReleaseManifest, role: ReleaseRole, observed: Record<'starter' | 'support', number>): string[] {
  const errors: string[] = [];
  for (const entry of manifest.compatibility.schemas) {
    const value = observed[entry.id];
    for (const access of ['read', 'write'] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || !contains(entry.roles[role][access], value)) errors.push(`${entry.id}.${role}.${access}`);
    }
    if (role === 'migrate' && !contains(entry.migration.from, value)) errors.push(`${entry.id}.migration.from`);
  }
  return errors;
}

/** All roles resolve one server reference; caller cannot supply per-role image overrides. */
export function serverRoleImages(manifest: ReleaseManifest, selectedPlatform: 'linux/amd64' | 'linux/arm64') {
  const record = manifest.images.server;
  const selected = record.platforms.find(entry => entry.platform === selectedPlatform);
  if (!selected) throw new Error('Release does not contain the selected platform');
  const identity = { index: `${record.repository}@${record.indexDigest}`, platform: `${record.repository}@${selected.manifestDigest}` };
  return { api: { ...identity }, worker: { ...identity }, migrate: { ...identity } };
}
