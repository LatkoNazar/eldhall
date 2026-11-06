import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { observeSchemaState } from '../src/release/schema-state.js';
import { schemaStateProfile } from '../src/release/schema-state-contracts.js';
import { matchSchemaReferences, planSchemaAdmission, schemaReferenceRegistrySchema, type SchemaReferenceRegistry } from '../src/release/schema-state-registry.js';
import { disposableSchemaDatabase, retainSchemaCandidates, schemaCandidateReferences, schemaFixtureIdentity, schemaFixtureSources } from './helpers/schema-state-reference.js';

function isObserverMarkerRead(call: { this: unknown; arguments: unknown[] }) {
  if (!call.this || typeof call.this !== 'object') return false;
  const parameters: unknown = Reflect.get(call.this, 'connectionParameters');
  return parameters !== null && typeof parameters === 'object' && Reflect.get(parameters, 'application_name') === 'eldhall-schema-observer' &&
    typeof call.arguments[0] === 'string' && /^SELECT version_num FROM ONLY public\.alembic_version\b/.test(call.arguments[0]);
}

test('actual PG17 observations, empirical references and read-only namespace guards', { timeout: 180_000 }, async t => {
  schemaFixtureIdentity(); // Missing service/test inputs fail; this explicit lane never skips.
  const sources = await schemaFixtureSources();
  const databases: Awaited<ReturnType<typeof disposableSchemaDatabase>>[] = [];
  const make = async (kind: 'plain' | 'vector') => { const value = await disposableSchemaDatabase(kind); databases.push(value); return value; };
  try {
    const plain = await make('plain'), vector = await make('vector'), limited = await make('vector'), other = await make('plain');
    await plain.migrateCurrent(); await plain.migrateCurrent(); await vector.migrateCurrent(); await limited.migrateCurrent(true, true);
    const baseline = await observeSchemaState(plain), vectors = await observeSchemaState(vector), uninstalled = await observeSchemaState(limited);
    for (const value of [baseline, vectors, uninstalled]) assert.equal(value.status, 'observed', 'Actual PG catalog observation must succeed');
    assert.equal(baseline.components.support.profile, 'vector-unavailable');
    assert.equal(vectors.components.support.profile, 'vector-installed');
    assert.equal(uninstalled.components.support.profile, 'vector-available-uninstalled');
    const candidates = [...schemaCandidateReferences(baseline, sources, plain.fixtureImageInput), ...schemaCandidateReferences(vectors, sources, vector.fixtureImageInput), ...schemaCandidateReferences(uninstalled, sources, limited.fixtureImageInput)];
    const entries = [...new Map(candidates.map(entry => [entry.id, entry])).values()];
    // Ephemeral test authority from controlled reference DBs; candidate output below
    // remains unreviewed and is never automatically installed as a trusted registry.
    const registry: SchemaReferenceRegistry = schemaReferenceRegistrySchema.parse({ registryFormat: 1, status: 'reviewed', observerProfile: schemaStateProfile, entries });
    const target = { starter: schemaCandidateReferences(baseline, sources, plain.fixtureImageInput)[0]!.id, support: schemaCandidateReferences(baseline, sources, plain.fixtureImageInput)[1]!.id };

    await t.test('fresh absent DB is not epoch zero; independent full migration has same semantic identity', async () => {
      const absent = await observeSchemaState(other);
      assert.equal(absent.status, 'observed'); assert.equal(absent.components.starter.presence, 'absent'); assert.equal(absent.components.support.presence, 'absent');
      assert.equal(planSchemaAdmission(absent, registry, sources, target).schemaEligible.api, false);
      await other.migrateCurrent(false);
      const partial = await observeSchemaState(other);
      assert.equal(matchSchemaReferences(partial, registry, sources).starter.status, 'matched');
      assert.equal(planSchemaAdmission(partial, registry, sources, target).schemaEligible.api, false);
      await other.migrateCurrent();
      const complete = await observeSchemaState(other);
      assert.deepEqual(complete.components, baseline.components);
      assert.equal(planSchemaAdmission(complete, registry, sources, target).schemaEligible.api, true);
    });

    await t.test('unrelated support_tickets and foreign function body are not claimed or read', async () => {
      await plain.owner.query("CREATE TABLE public.support_tickets(secret text);INSERT INTO public.support_tickets VALUES('synthetic-private-business-value');CREATE FUNCTION public.unrelated_secret() RETURNS text LANGUAGE sql AS $$SELECT 'synthetic-private-function-value'$$");
      const observed = await observeSchemaState(plain);
      assert.deepEqual(observed.components, baseline.components); assert.equal(observed.unmanagedPublicRelations, 1);
      assert.equal(planSchemaAdmission(observed, registry, sources, target).schemaEligible.api, true);
      assert.doesNotMatch(JSON.stringify(observed), /synthetic-private|support_tickets|unrelated_secret/);
      assert.equal((await plain.owner.query('SELECT count(*)::int AS count FROM public.support_tickets')).rows[0]?.count, 1);
    });

    await t.test('actual default, guard/index and trigger drift loses the exact reference', async () => {
      await plain.owner.query('ALTER TABLE public.support_request_catalogs ADD COLUMN unexpected_schema_field text');
      assert.equal(matchSchemaReferences(await observeSchemaState(plain), registry, sources).support.status, 'denied');
      await plain.owner.query('ALTER TABLE public.support_request_catalogs DROP COLUMN unexpected_schema_field');
      assert.deepEqual((await observeSchemaState(plain)).components, baseline.components);
      await plain.owner.query("ALTER TABLE public.support_messages ALTER COLUMN source_refs SET DEFAULT '[1]'::jsonb");
      assert.equal(matchSchemaReferences(await observeSchemaState(plain), registry, sources).support.status, 'denied');
      await plain.owner.query("ALTER TABLE public.support_messages ALTER COLUMN source_refs SET DEFAULT '[]'::jsonb");
      await plain.owner.query('ALTER TABLE public.support_knowledge DISABLE TRIGGER support_knowledge_history');
      assert.equal(matchSchemaReferences(await observeSchemaState(plain), registry, sources).support.status, 'denied');
      await plain.owner.query('ALTER TABLE public.support_knowledge ENABLE TRIGGER support_knowledge_history');
      await vector.owner.query('DROP INDEX public.support_knowledge_chunks_hnsw');
      assert.equal(matchSchemaReferences(await observeSchemaState(vector), registry, sources).support.status, 'denied');
      await vector.migrateCurrent();
      assert.deepEqual((await observeSchemaState(vector)).components, vectors.components);
    });

    await t.test('wrong marker, RLS and inheritance cannot cause foreign marker rows to be read', async st => {
      const queries = st.mock.method(pg.Client.prototype, 'query');
      await other.owner.query("UPDATE public.alembic_version SET version_num='synthetic-private-marker'");
      const wrong = await observeSchemaState(other);
      assert.equal(wrong.starterMarker, 'unknown'); assert.equal(wrong.components.starter.presence, 'partial'); assert.doesNotMatch(JSON.stringify(wrong), /synthetic-private-marker/);
      assert.equal(queries.mock.calls.filter(isObserverMarkerRead).length, 1, 'Spy must observe the permitted ordinary marker read');
      queries.mock.resetCalls();
      await other.owner.query("UPDATE public.alembic_version SET version_num='0001_jobs';ALTER TABLE public.alembic_version ENABLE ROW LEVEL SECURITY;ALTER TABLE public.alembic_version FORCE ROW LEVEL SECURITY");
      assert.equal((await observeSchemaState(other)).starterMarker, 'unreadable');
      assert.equal(queries.mock.calls.filter(isObserverMarkerRead).length, 0, 'RLS marker must be refused before row SELECT');
      await other.owner.query('ALTER TABLE public.alembic_version DISABLE ROW LEVEL SECURITY;ALTER TABLE public.alembic_version NO FORCE ROW LEVEL SECURITY;CREATE TABLE public.marker_child(secret text) INHERITS(public.alembic_version)');
      await other.owner.query("INSERT INTO public.marker_child(version_num,secret) VALUES('child-private-marker','synthetic-private-child')");
      const inherited = await observeSchemaState(other);
      assert.equal(inherited.starterMarker, 'unreadable'); assert.doesNotMatch(JSON.stringify(inherited), /private-child|child-private-marker/);
      assert.equal(queries.mock.calls.filter(isObserverMarkerRead).length, 0, 'Inherited marker must be refused before row SELECT');
      await other.owner.query('DROP TABLE public.marker_child');
    });

    await t.test('concurrent marker replacement is bounded and never follows a new view', async st => {
      const queries = st.mock.method(pg.Client.prototype, 'query');
      await other.owner.query("CREATE TABLE public.marker_trap(calls integer NOT NULL);INSERT INTO public.marker_trap VALUES(0);CREATE FUNCTION public.marker_trap_function() RETURNS varchar(32) LANGUAGE plpgsql AS $$BEGIN UPDATE public.marker_trap SET calls=calls+1;RETURN 'synthetic-private-view';END$$");
      await other.owner.query('BEGIN');
      await other.owner.query('ALTER TABLE public.alembic_version RENAME TO marker_previous');
      await other.owner.query('CREATE VIEW public.alembic_version AS SELECT public.marker_trap_function() AS version_num');
      const pending = observeSchemaState(other);
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        await other.owner.query('SELECT pg_catalog.pg_stat_clear_snapshot()');
        waiting = (await other.owner.query("SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname=$1 AND application_name='eldhall-schema-observer' AND wait_event_type='Lock'", [other.name])).rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      await other.owner.query('COMMIT');
      const result = await pending;
      assert.equal(waiting, true, 'Fixture must exercise the real relation replacement lock race');
      assert.equal(result.status, 'unobservable'); assert.doesNotMatch(JSON.stringify(result), /synthetic-private-view/);
      assert.equal(queries.mock.calls.filter(isObserverMarkerRead).length, 0, 'Replacement must be refused before row SELECT, independently of readonly enforcement');
      assert.equal((await other.owner.query('SELECT calls FROM public.marker_trap')).rows[0]?.calls, 0);
    });
    await retainSchemaCandidates(candidates);
  } finally {
    const cleanup = await Promise.allSettled(databases.reverse().map(database => database.close()));
    assert.equal(cleanup.every(result => result.status === 'fulfilled'), true, 'All exclusively created fixture databases must be removed');
  }
});
