import pg from 'pg';
import { schemaObservationSchema, schemaStateHash, schemaStateProfile, starterRelations, supportRelations, vectorRelation, type SchemaObservation } from './schema-state-contracts.js';
import { schemaCatalogQueries, schemaContextQuery, schemaHistoryFunctionQuery, schemaUnmanagedQuery, schemaVectorQuery } from './schema-state-sql.js';

const tlsKeys = new Set(['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation']);
/** Observer-only explicit password-auth URL profile. Runtime URL support is unchanged. */
function connectionConfig(input: unknown): pg.ClientConfig {
  if (typeof input !== 'string' || Buffer.byteLength(input) > 16_384 || [...input].some(character => character.codePointAt(0)! <= 32 || character.codePointAt(0) === 127) || input.includes('#')) throw new Error('Invalid explicit connection');
  const url = new URL(input);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !decodeURIComponent(url.username) || !decodeURIComponent(url.password) || !decodeURIComponent(url.pathname.slice(1))) throw new Error('Explicit target and password authentication required');
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!tlsKeys.has(key) || seen.has(key)) throw new Error('Unsupported or ambiguous connection option');
    seen.add(key);
  }
  url.port ||= '5432';
  // Truthy explicit values avoid node-postgres's libpq environment fallbacks.
  url.searchParams.set('replication', 'false');
  return { connectionString: url.toString(), ssl: false, sslnegotiation: 'postgres',
    options: '-c default_transaction_read_only=on -c search_path=pg_catalog', application_name: 'eldhall-schema-observer', client_encoding: 'UTF8',
    connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 3000, lock_timeout: 1000, idle_in_transaction_session_timeout: 5000 };
}

export function schemaStateConnectionConfig(input: unknown): pg.ClientConfig {
  try { return connectionConfig(input); } catch { throw new Error('Invalid explicit observer connection'); }
}

function unavailable(reason: SchemaObservation['reason']): SchemaObservation {
  const part = { presence: 'unobservable' as const, profile: 'unsupported' as const, fingerprint: null };
  return { observationFormat: 1, observerProfile: schemaStateProfile, status: 'unobservable', postgresVersionNum: null, databaseLocaleFingerprint: null,
    components: { starter: { ...part }, support: { ...part } }, starterMarker: 'unreadable', vector: { available: null, installed: null, version: null, namespace: null }, unmanagedPublicRelations: null, reason };
}

type Row = Record<string, unknown>;
function rowsSafe(rows: Row[], maximum: number) {
  if (rows.length > maximum || Buffer.byteLength(JSON.stringify(rows)) > 1_000_000) throw new Error('Catalog observation limit');
  return rows;
}

/** Always creates and closes its own connection. Never accepts an application client. */
export async function observeSchemaState(input: { connectionString: string }): Promise<SchemaObservation> {
  let config: pg.ClientConfig;
  try { config = schemaStateConnectionConfig(input?.connectionString); } catch { return unavailable('invalid_connection'); }
  let client: pg.Client | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    client = new pg.Client(config);
    client.on('error', () => { /* Operation results remain generic and the dedicated client is closed. */ });
    const activeClient = client;
    deadline = setTimeout(() => { void activeClient.end().catch(() => undefined); }, 25_000);
    deadline.unref();
    await client.connect();
    // Autocommit catalog preflight does not establish the following transaction's
    // snapshot. Lock before its first SELECT, so same-OID ALTER races cannot leave
    // stale column/RLS metadata authorizing a later marker read.
    const preflight = (await client.query("SELECT c.oid::text AS id,c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='alembic_version'")).rows[0];
    if (preflight && preflight.kind !== 'r') throw new Error('Marker is not an ordinary table');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL search_path TO pg_catalog');
    await client.query('SET LOCAL row_security TO off');
    if (preflight) {
      await client.query('LOCK TABLE ONLY public.alembic_version IN ACCESS SHARE MODE');
      const identity = (await client.query("SELECT pg_catalog.to_regclass('public.alembic_version')::oid::text AS id")).rows[0];
      if (!identity || identity.id !== preflight.id) throw new Error('Marker identity changed');
    }
    const version = Number((await client.query("SELECT pg_catalog.current_setting('server_version_num') AS version")).rows[0]?.version);
    if (!Number.isInteger(version) || version < 170000 || version > 179999) return unavailable('unsupported_postgres');
    const context = (await client.query(schemaContextQuery)).rows[0];
    if (!context || context.version !== version || typeof context.locale_hash !== 'string' || typeof context.vector_available !== 'boolean') throw new Error('Catalog context unavailable');
    const extensions = rowsSafe((await client.query(schemaVectorQuery)).rows, 1);
    const extension = extensions[0];
    const vector = { available: context.vector_available, installed: !!extension,
      version: extension && typeof extension.version === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(extension.version) ? extension.version : null,
      namespace: extension ? extension.namespace === 'public' ? 'public' as const : 'other' as const : null };
    const names = [...starterRelations, ...supportRelations, vectorRelation];
    const catalog: Record<string, Row[]> = {};
    for (const [name, query] of Object.entries(schemaCatalogQueries)) catalog[name] = rowsSafe((await client.query(query, [names])).rows, name === 'relations' ? 32 : name === 'columns' ? 2048 : 1024);
    // No function text is inspected except this exact reviewed zero-argument identity.
    const functions = rowsSafe((await client.query(schemaHistoryFunctionQuery)).rows, 1);
    const relations = catalog.relations!;
    const markerRelation = relations.find(row => row.name === 'alembic_version');
    let marker: SchemaObservation['starterMarker'] = 'absent';
    if (markerRelation) {
      if (!preflight || markerRelation.object_id !== preflight.id) throw new Error('Marker appeared or changed during observation');
      const column = catalog.columns!.filter(row => row.relation === 'alembic_version');
      if (markerRelation.kind !== 'r' || markerRelation.rls || markerRelation.force_rls || markerRelation.rules !== 0 || markerRelation.inheritance !== 0 || column.length !== 1 || column[0]?.name !== 'version_num' || column[0]?.type_schema !== 'pg_catalog' || column[0]?.type !== 'varchar' || column[0]?.typmod !== 36) marker = 'unreadable';
      else {
        const values = (await client.query('SELECT version_num FROM ONLY public.alembic_version LIMIT 2')).rows;
        marker = values.length === 1 && values[0]?.version_num === '0001_jobs' ? 'current' : 'unknown';
      }
    }
    const regular = (row: Row) => row.kind === 'r' && row.persistence === 'p';
    const baseSupport = relations.filter(row => supportRelations.some(name => name === row.name));
    const starter = relations.filter(row => starterRelations.some(name => name === row.name));
    const chunks = relations.find(row => row.name === vectorRelation);
    const hasHistoryTrigger = catalog.triggers!.some(row => row.relation === 'support_knowledge' && row.name === 'support_knowledge_history');
    const supportPresent = baseSupport.length > 0 || !!chunks || functions.length > 0;
    const vectorProfile = vector.installed ? vector.namespace === 'public' && vector.version ? 'vector-installed' as const : 'unsupported' as const : vector.available ? 'vector-available-uninstalled' as const : 'vector-unavailable' as const;
    const supportComplete = baseSupport.length === supportRelations.length && baseSupport.every(regular) && functions.length === 1 && hasHistoryTrigger &&
      (vector.installed ? !!chunks && regular(chunks) && vectorProfile !== 'unsupported' : !chunks);
    const extract = (componentNames: readonly string[]) => Object.fromEntries(Object.entries(catalog).map(([kind, rows]) => [kind, rows.filter(row => componentNames.includes(String(kind === 'relations' ? row.name : row.relation))).map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'object_id')))]));
    const starterPresence = starter.length === 0 ? 'absent' as const : starter.length === starterRelations.length && starter.every(regular) && marker === 'current' ? 'present' as const : 'partial' as const;
    const supportPresence = !supportPresent ? 'absent' as const : supportComplete ? 'present' as const : 'partial' as const;
    const components = {
      starter: { presence: starterPresence, profile: 'starter-public' as const, fingerprint: starterPresence === 'absent' ? null : schemaStateHash({ observerProfile: schemaStateProfile, locale: context.locale_hash, marker, catalog: extract(starterRelations) }) },
      support: { presence: supportPresence, profile: vectorProfile, fingerprint: supportPresence === 'absent' ? null : schemaStateHash({ observerProfile: schemaStateProfile, locale: context.locale_hash, vector, catalog: extract([...supportRelations, vectorRelation]), functions }) },
    };
    const unmanaged = (await client.query(schemaUnmanagedQuery, [names])).rows[0]?.count;
    const result = schemaObservationSchema.parse({ observationFormat: 1, observerProfile: schemaStateProfile, status: 'observed', postgresVersionNum: version, databaseLocaleFingerprint: context.locale_hash,
      components, starterMarker: marker, vector, unmanagedPublicRelations: unmanaged, reason: null });
    await client.query('COMMIT');
    return result;
  } catch { return unavailable('connection_or_catalog_unavailable'); }
  finally { clearTimeout(deadline); await client?.end().catch(() => undefined); }
}

export { schemaObservationSchema } from './schema-state-contracts.js';
export type { SchemaObservation } from './schema-state-contracts.js';
