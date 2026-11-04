import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { schemaSourcePaths, schemaStateHash, schemaStateProfile, type SchemaObservation, type SchemaSources } from '../src/release/schema-state-contracts.js';
import { matchSchemaReferences, parseSchemaReferenceRegistry, planSchemaAdmission, schemaReferenceRegistrySchema, type SchemaReferenceRegistry } from '../src/release/schema-state-registry.js';
import { observeSchemaState, schemaStateConnectionConfig } from '../src/release/schema-state.js';
import { schemaFixtureIdentity, schemaFixtureInputs } from './helpers/schema-state-reference.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
// Synthetic unit-only values: never persisted, promoted or used as PG references.
function fixture() {
  const sources: SchemaSources = { starter: schemaSourcePaths.starter.map(path => ({ path, sha256: hash(path) })), support: schemaSourcePaths.support.map(path => ({ path, sha256: hash(path) })) };
  const observation: SchemaObservation = { observationFormat: 1, observerProfile: schemaStateProfile, status: 'observed', postgresVersionNum: 170011, databaseLocaleFingerprint: hash('synthetic-locale'),
    components: { starter: { presence: 'present', profile: 'starter-public', fingerprint: hash('synthetic-starter') }, support: { presence: 'present', profile: 'vector-unavailable', fingerprint: hash('synthetic-support') } },
    starterMarker: 'current', vector: { available: false, installed: false, version: null, namespace: null }, unmanagedPublicRelations: 0, reason: null };
  const registry: SchemaReferenceRegistry = { registryFormat: 1, observerProfile: schemaStateProfile, status: 'reviewed', entries: (['starter', 'support'] as const).map(component => ({
    id: `synthetic-${component}`, component, profile: component === 'starter' ? 'starter-public' : 'vector-unavailable', fingerprint: observation.components[component].fingerprint!, sources: sources[component], evidence: { sourceCommit: 'a'.repeat(40), runId: '1', postgresVersionNum: 170011, fixtureImageInput: 'docker.io/library/postgres:unit-fixture@sha256:' + hash('synthetic-image') },
  })) };
  return { sources, observation, registry, target: { starter: 'synthetic-starter', support: 'synthetic-support' } };
}

test('strict explicit registry/source matching and pure plan never infer epochs or authorize mutation', () => {
  const { sources, observation, registry, target } = fixture();
  const parsed = parseSchemaReferenceRegistry(JSON.stringify(registry));
  assert.equal(matchSchemaReferences(observation, parsed, sources).support.status, 'matched');
  const plan = planSchemaAdmission(observation, parsed, sources, target);
  assert.deepEqual(plan.schemaEligible, { api: true, worker: true });
  assert.equal(plan.mutationAuthorized, false); assert.equal(plan.mode, 'diagnostic-only'); assert.equal(plan.migration, 'not-required');
  assert.doesNotMatch(JSON.stringify(plan), /epoch|databaseUrl|password/);
  const unrelated = { ...observation, unmanagedPublicRelations: 42 };
  assert.deepEqual(planSchemaAdmission(unrelated, parsed, sources, target), plan);
});

test('unknown, partial, absent, unavailable, source drift and wrong target deny without live enrollment', async () => {
  const { sources, observation, registry, target } = fixture();
  for (const presence of ['absent', 'partial'] as const) {
    const changed = structuredClone(observation); changed.components.support.presence = presence; if (presence === 'absent') changed.components.support.fingerprint = null;
    assert.equal(planSchemaAdmission(changed, registry, sources, target).schemaEligible.api, false);
  }
  const changed = structuredClone(observation); changed.components.starter.fingerprint = hash('unreviewed');
  assert.equal(planSchemaAdmission(changed, registry, sources, target).schemaEligible.worker, false);
  const altered = structuredClone(sources); altered.support.at(-1)!.sha256 = hash('altered-runner');
  assert.equal(matchSchemaReferences(observation, registry, altered).support.status, 'denied');
  assert.equal(planSchemaAdmission(observation, registry, sources, { ...target, support: 'other' }).schemaEligible.api, false);
  assert.equal(matchSchemaReferences(observation, { ...registry, entries: [] }, sources).starter.status, 'denied');
  assert.equal(matchSchemaReferences(observation, { ...registry, status: 'candidate' }, sources).starter.status, 'denied');
  assert.equal(matchSchemaReferences({ ...observation, starterMarker: 'unknown' }, registry, sources).starter.status, 'denied');
  assert.equal(matchSchemaReferences({ ...observation, vector: { ...observation.vector, installed: true } }, registry, sources).support.status, 'denied');
  const unavailable = await observeSchemaState({ connectionString: 'invalid-synthetic-private-value' });
  assert.equal(unavailable.status, 'unobservable'); assert.equal(unavailable.components.starter.presence, 'unobservable');
  assert.equal(planSchemaAdmission(unavailable, registry, sources, target).schemaEligible.api, false);
});

test('registry refuses ambiguous JSON, duplicate identities, unsupported fields and missing runner hashes', () => {
  const { registry } = fixture();
  for (const text of ['{"private-secret":', '{"registryFormat":1,' + JSON.stringify(registry).slice(1), '['.repeat(100) + '0' + ']'.repeat(100), 'x'.repeat(200_001)]) {
    assert.throws(() => parseSchemaReferenceRegistry(text), error => error instanceof Error && error.message === 'Schema reference registry is invalid');
  }
  const duplicate = structuredClone(registry); duplicate.entries.push(duplicate.entries[0]!);
  assert.equal(schemaReferenceRegistrySchema.safeParse(duplicate).success, false);
  const missing = structuredClone(registry); missing.entries[1]!.sources.pop();
  assert.equal(schemaReferenceRegistrySchema.safeParse(missing).success, false);
  assert.equal(schemaReferenceRegistrySchema.safeParse({ ...registry, epoch: 1 }).success, false);
});

test('explicit connection profile refuses ambiguous routing, incomplete auth and raw input errors', async () => {
  for (const value of ['postgres://localhost/app', 'postgres://user@localhost/app', 'postgres://user:synthetic-private@localhost', 'https://user:synthetic-private@localhost/app', 'postgres://user:synthetic-private@localhost/app#fragment', 'postgres://user:synthetic-private@localhost/app?host=other', 'postgres://user:synthetic-private@localhost/app?sslmode=disable&sslmode=verify-full', 'postgres://user:synthetic-private@localhost/app?options=unsafe']) {
    assert.throws(() => schemaStateConnectionConfig(value), error => error instanceof Error && error.message === 'Invalid explicit observer connection');
    const result = await observeSchemaState({ connectionString: value });
    assert.equal(result.status, 'unobservable'); assert.equal(result.reason, 'invalid_connection');
    assert.equal(JSON.stringify(result).includes('synthetic-private'), false);
  }
});

test('actual pg client routing/TLS/options ignore ambient libpq defaults without mutating parent env', () => {
  const moduleUrl = new URL('../src/release/schema-state.ts', import.meta.url).href;
  const program = `import pg from 'pg';import{schemaStateConnectionConfig as config}from ${JSON.stringify(moduleUrl)};
    const client=new pg.Client(config('postgres://explicit:synthetic-password@127.0.0.1/explicitdb?sslmode=verify-full'));
    const plain=new pg.Client(config('postgres://explicit:synthetic-password@127.0.0.1/explicitdb'));
    console.log(JSON.stringify({host:client.host,user:client.user,database:client.database,port:client.port,passwordExplicit:client.password==='synthetic-password',readonly:client.connectionParameters.options.includes('default_transaction_read_only=on'),replication:client.connectionParameters.replication,tls:typeof client.ssl==='object'&&client.ssl.rejectUnauthorized!==false,plain:plain.ssl===false}));`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { encoding: 'utf8', timeout: 15_000, env: {
    PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', PGHOST: 'ambient.invalid', PGPORT: '5439', PGDATABASE: 'ambientdb', PGUSER: 'ambientuser', PGPASSWORD: 'ambient-private', PGOPTIONS: '-c default_transaction_read_only=off', PGSSLMODE: 'no-verify', PGSSLNEGOTIATION: 'invalid-ambient', PGREPLICATION: 'database',
  } });
  assert.equal(result.status, 0, 'Actual pg parameter routing proof failed');
  assert.deepEqual(JSON.parse(result.stdout), { host: '127.0.0.1', user: 'explicit', database: 'explicitdb', port: 5432, passwordExplicit: true, readonly: true, replication: 'false', tls: true, plain: true });
});

test('synchronous TLS file errors return generic unobservable state without connecting or leaking paths', async t => {
  const connect = t.mock.method(pg.Client.prototype, 'connect', () => { throw new Error('Network forbidden by test'); });
  for (const key of ['sslrootcert', 'sslcert', 'sslkey']) {
    const privatePath = resolve(tmpdir(), 'synthetic-private-missing-' + randomUUID() + '.pem');
    const url = new URL('postgres://explicit:synthetic-password@127.0.0.1/explicitdb');
    url.searchParams.set(key, privatePath);
    const result = await observeSchemaState({ connectionString: url.href });
    assert.equal(result.status, 'unobservable'); assert.equal(result.reason, 'connection_or_catalog_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private|\.pem|synthetic-password/);
  }
  assert.equal(connect.mock.callCount(), 0, 'Missing TLS files must fail before any connection');
});

test('schema hashing is deterministic over metadata keys and preserves semantic literals/order', () => {
  assert.equal(schemaStateHash({ b: 2, a: 1 }), schemaStateHash({ a: 1, b: 2 }));
  assert.notEqual(schemaStateHash(['one', 'two']), schemaStateHash(['two', 'one']));
  assert.notEqual(schemaStateHash("'upper case'"), schemaStateHash("'uppercase'"));
  assert.throws(() => schemaStateHash({ unsupported: undefined }));
});

test('disposable fixture admission requires matching GitHub identity and exact declared services before connecting', () => {
  const env: NodeJS.ProcessEnv = { TEST_SCHEMA_FIXTURES_ALLOWED: '1', GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40), SCHEMA_STATE_SOURCE_COMMIT: 'a'.repeat(40), GITHUB_RUN_ID: '123', SCHEMA_STATE_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SCHEMA_STATE_RUN_ATTEMPT: '1',
    TEST_POSTGRES_HOST: '127.0.0.1', TEST_POSTGRES_PORT: '5432', TEST_POSTGRES_USER: 'app', TEST_POSTGRES_DB: 'app', TEST_POSTGRES_PASSWORD: 'development-only',
    TEST_SCHEMA_PLAIN_POSTGRES_HOST: '127.0.0.1', TEST_SCHEMA_PLAIN_POSTGRES_PORT: '5433', TEST_SCHEMA_PLAIN_POSTGRES_USER: 'app', TEST_SCHEMA_PLAIN_POSTGRES_DB: 'schema_observer', TEST_SCHEMA_PLAIN_POSTGRES_PASSWORD: 'development-only' };
  assert.deepEqual(schemaFixtureIdentity(env), { sourceCommit: 'a'.repeat(40), runId: '123', attempt: '1' });
  assert.equal(schemaFixtureInputs('plain', env).port, 5433); assert.equal(schemaFixtureInputs('vector', env).database, 'app');
  for (const key of ['TEST_SCHEMA_FIXTURES_ALLOWED', 'GITHUB_ACTIONS', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'SCHEMA_STATE_SOURCE_COMMIT', 'SCHEMA_STATE_RUN_ID', 'SCHEMA_STATE_RUN_ATTEMPT']) {
    assert.throws(() => schemaFixtureInputs('plain', { ...env, [key]: undefined }));
    assert.throws(() => schemaFixtureInputs('plain', { ...env, [key]: 'mismatch' }));
  }
  for (const prefix of ['TEST_POSTGRES_', 'TEST_SCHEMA_PLAIN_POSTGRES_']) for (const field of ['HOST', 'PORT', 'USER', 'DB', 'PASSWORD']) {
    const changed = { ...env, [prefix + field]: 'synthetic-other-target' };
    assert.throws(() => schemaFixtureInputs(prefix === 'TEST_POSTGRES_' ? 'vector' : 'plain', changed), error => error instanceof Error && !error.message.includes('synthetic-other-target'));
  }
  assert.throws(() => schemaFixtureInputs('vector', { DATABASE_URL: 'postgres://ignored-private-target' }));
});
