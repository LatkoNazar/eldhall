// Test-only disposable DB fixture. Not a generator CLI or application adapter.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../src/core/migrations.js';
import { migrateSupport } from '../../src/modules/support/migrations.js';
import { schemaSourcePaths, schemaStateProfile, type SchemaComponent, type SchemaObservation, type SchemaSources } from '../../src/release/schema-state-contracts.js';
import type { SchemaReference } from '../../src/release/schema-state-registry.js';

export const fixtureRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const namePattern = /^eldhall_schema_state_[a-f0-9]{32}$/;
// Declared CI service inputs, not an assertion of daemon/runtime inspection.
const fixtureImages = {
  plain: 'docker.io/library/postgres:17.11-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b',
  vector: 'docker.io/pgvector/pgvector:0.8.0-pg17@sha256:40b404964359299eefdd5f8518facf1886c562848cf4de13b6eaf91cb70c2b87',
};
function required(name: string, env: NodeJS.ProcessEnv) { const value = env[name]; if (!value) throw new Error('Explicit schema fixture inputs are required'); return value; }

export function schemaFixtureIdentity(env: NodeJS.ProcessEnv = process.env) {
  if (required('TEST_SCHEMA_FIXTURES_ALLOWED', env) !== '1' || required('GITHUB_ACTIONS', env) !== 'true') throw new Error('Disposable schema fixtures are not enabled');
  const sourceCommit = required('SCHEMA_STATE_SOURCE_COMMIT', env), runId = required('SCHEMA_STATE_RUN_ID', env), attempt = required('SCHEMA_STATE_RUN_ATTEMPT', env);
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[0-9]{1,30}$/.test(runId) || !/^[0-9]{1,10}$/.test(attempt)) throw new Error('Schema fixture identity is invalid');
  if (sourceCommit !== required('GITHUB_SHA', env) || runId !== required('GITHUB_RUN_ID', env) || attempt !== required('GITHUB_RUN_ATTEMPT', env)) throw new Error('Schema fixture identity does not match CI');
  return { sourceCommit, runId, attempt };
}

export function schemaFixtureInputs(kind: 'plain' | 'vector', env: NodeJS.ProcessEnv = process.env) {
  schemaFixtureIdentity(env);
  const prefix = kind === 'plain' ? 'TEST_SCHEMA_PLAIN_POSTGRES_' : 'TEST_POSTGRES_';
  const host = required(prefix + 'HOST', env), port = required(prefix + 'PORT', env), user = required(prefix + 'USER', env), password = required(prefix + 'PASSWORD', env), database = required(prefix + 'DB', env);
  if (host !== '127.0.0.1' || port !== (kind === 'plain' ? '5433' : '5432') || user !== 'app' || password !== 'development-only' || database !== (kind === 'plain' ? 'schema_observer' : 'app')) throw new Error('Schema fixtures require the exact declared CI service');
  return { host, port: Number(port), user, password, database };
}

export async function schemaFixtureSources(): Promise<SchemaSources> {
  const files = async (component: SchemaComponent) => Promise.all(schemaSourcePaths[component].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(fixtureRoot, path))).digest('hex') })));
  return { starter: await files('starter'), support: await files('support') };
}

export async function disposableSchemaDatabase(kind: 'plain' | 'vector') {
  const { host, port, user, password, database } = schemaFixtureInputs(kind);
  const url = (name: string) => `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}?sslmode=disable`;
  const client = (name: string) => new pg.Client({ connectionString: url(name) + '&replication=false', ssl: false, options: '-c search_path=pg_catalog', application_name: 'eldhall-schema-fixture', connectionTimeoutMillis: 3000, query_timeout: 5000 });
  const admin = client(database);
  const name = 'eldhall_schema_state_' + randomUUID().replaceAll('-', '');
  let created = false;
  await admin.connect();
  try {
    const version = Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0]?.version);
    if (version < 170000 || version > 179999 || !namePattern.test(name)) throw new Error('Schema fixture PG17 identity is invalid');
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    const owner = client(name); await owner.connect();
    const migrateCurrent = async (support = true, restricted = false) => {
      if (restricted) await owner.query('GRANT CREATE ON SCHEMA public TO pg_read_all_data');
      const pool = new pg.Pool({ connectionString: url(name) + '&replication=false', ssl: false, options: restricted ? '-c role=pg_read_all_data -c search_path=public' : '-c search_path=public', connectionTimeoutMillis: 3000, max: 1 });
      try { await migrate(pool); if (support) await migrateSupport(pool); } finally { await pool.end(); }
    };
    return { name, connectionString: url(name), fixtureImageInput: fixtureImages[kind], owner, migrateCurrent,
      async close() {
        await owner.end();
        if (!created || !namePattern.test(name)) throw new Error('Fixture cleanup identity is invalid');
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        created = false; await admin.end();
      },
    };
  } catch (error) {
    if (created && namePattern.test(name)) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined);
    await admin.end(); throw error;
  }
}

export function schemaCandidateReferences(observation: SchemaObservation, sources: SchemaSources, fixtureImageInput: string): SchemaReference[] {
  const identity = schemaFixtureIdentity();
  if (observation.status !== 'observed' || observation.postgresVersionNum === null) throw new Error('Reference requires an actual PG observation');
  return (['starter', 'support'] as const).map(component => {
    const state = observation.components[component];
    if (state.presence !== 'present' || !state.fingerprint || state.profile === 'unsupported') throw new Error('Candidate component is not complete');
    return { id: `${component}-${state.fingerprint}`, component, profile: state.profile, fingerprint: state.fingerprint, sources: sources[component], evidence: { sourceCommit: identity.sourceCommit, runId: identity.runId, postgresVersionNum: observation.postgresVersionNum!, fixtureImageInput } };
  });
}

export async function retainSchemaCandidates(references: SchemaReference[]) {
  const identity = schemaFixtureIdentity();
  const unique = [...new Map(references.map(reference => [reference.id, reference])).values()];
  const directory = resolve(fixtureRoot, '.omc/artifacts/schema-state');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = resolve(directory, `candidates-${identity.sourceCommit}-${identity.runId}-${identity.attempt}.json`);
  const observerFiles = ['schema-state.ts', 'schema-state-contracts.ts', 'schema-state-sql.ts', 'schema-state-registry.ts'];
  const observerSources = await Promise.all(observerFiles.map(async name => ({ path: 'apps/api/src/release/' + name, sha256: createHash('sha256').update(await readFile(resolve(fixtureRoot, 'apps/api/src/release', name))).digest('hex') })));
  await writeFile(target, JSON.stringify({ candidateFormat: 1, status: 'unreviewed', observerProfile: schemaStateProfile, sourceCommit: identity.sourceCommit, runId: identity.runId, observerSources, references: unique }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
