import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { databaseInvestigationSourceSchema, DEFAULT_DATABASE_LIMITS, type DatabaseInvestigationPolicy } from '../src/modules/database/contracts.js';
import { createDatabaseInvestigationService } from '../src/modules/database/service.js';
import type { NewActivity } from '../src/modules/support/activity.js';

test('database investigation isolates real PostgreSQL joins/aggregates, capabilities and bounded results', { timeout: 60000 }, async t => {
  const input = process.env.TEST_DATABASE_URL;
  const explicit = input ? new URL(input) : undefined;
  const host = explicit?.hostname ?? process.env.TEST_POSTGRES_HOST, port = explicit?.port ?? process.env.TEST_POSTGRES_PORT;
  if (host !== '127.0.0.1' || (port !== '25434' && !(port === '5432' && process.env.GITHUB_ACTIONS === 'true'))) throw new Error('Explicit owned disposable PostgreSQL fixture is required');
  const database = explicit ? decodeURIComponent(explicit.pathname.slice(1)) : process.env.TEST_POSTGRES_DB;
  const user = explicit ? decodeURIComponent(explicit.username) : process.env.TEST_POSTGRES_USER;
  const password = explicit ? decodeURIComponent(explicit.password) : process.env.TEST_POSTGRES_PASSWORD;
  if (user !== 'app' || !database || password === undefined) throw new Error('Explicit disposable PostgreSQL identity required');
  const base = { host, port: Number(port), database, user, password, ssl: false, connectionTimeoutMillis: 3000 };
  const admin = new pg.Pool(base), suffix = randomUUID().replaceAll('-', ''), schema = 'dbread_' + suffix, role = 'dbreader_' + suffix;
  const businessA = randomUUID(), businessB = randomUUID(), customerA = randomUUID(), customerB = randomUUID(), accountA = randomUUID(), accountB = randomUUID(), accountForeignBusiness = randomUUID();
  const policy: DatabaseInvestigationPolicy & { version: number } = { version: 1, enabled: true, limits: { ...DEFAULT_DATABASE_LIMITS } };
  const activities: NewActivity[] = [];
  const source = databaseInvestigationSourceSchema.parse({ id: 'records', label: 'Disposable records', businessId: businessA, schema, credentialEnv: 'TEST_DATABASE_READER', relations: [{ table: 'accounts', columns: ['id','business_id','customer_id','label'], ownership: { kind:'columns', businessColumn:'business_id', customerColumn:'customer_id' } }, { table: 'transactions', ownership: { kind: 'parent', parentTable: 'accounts', foreignKey: 'account_id', parentKey: 'id' } }] });
  let reader: pg.Pool | undefined, service: ReturnType<typeof createDatabaseInvestigationService> | undefined, functionNotices=0;
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'synthetic-read-only-password'`);
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}".accounts(id uuid PRIMARY KEY,business_id uuid NOT NULL,customer_id uuid NOT NULL,label text,private_note text);
      CREATE INDEX accounts_scope ON "${schema}".accounts(business_id,customer_id);
      CREATE TABLE "${schema}".transactions(id integer PRIMARY KEY,account_id uuid REFERENCES "${schema}".accounts(id),amount numeric,posted_at timestamptz);
      CREATE TABLE "${schema}".documents(id integer PRIMARY KEY,business_id uuid NOT NULL,customer_id uuid NOT NULL,body text)`);
    await admin.query(`INSERT INTO "${schema}".accounts VALUES($1,$2,$3,'own','private-own'),($4,$2,$5,'foreign-customer','private-foreign'),($6,$7,$3,'foreign-business','private-business')`, [accountA, businessA, customerA, accountB, customerB, accountForeignBusiness, businessB]);
    await admin.query(`INSERT INTO "${schema}".transactions VALUES(1,$1,10.25,now()),(2,$1,20.25,now()),(3,$2,9999,now()),(4,$3,7777,now())`, [accountA, accountB, accountForeignBusiness]);
    await admin.query(`INSERT INTO "${schema}".documents SELECT i,$1,$2,repeat('x',5000) FROM generate_series(1,5) i`, [businessA, customerA]);
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT SELECT(id,business_id,customer_id,label) ON "${schema}".accounts TO "${role}"; GRANT SELECT ON "${schema}".transactions,"${schema}".documents TO "${role}"`);
    reader = new pg.Pool({ ...base, user: role, password: 'synthetic-read-only-password', max: 2 });
    reader.on('connect',client=>client.on('notice',notice=>{if(notice.message==='SYNTHETIC_FUNCTION_CALLED')functionNotices++;}));
    service = createDatabaseInvestigationService({ sources: [{ config: source, pool: reader }], getPolicy: async () => structuredClone(policy) });
    const context = (customerId = customerA) => ({ businessId: businessA, customerId, assertActive: async () => undefined, recordActivity: async (event: NewActivity) => { activities.push(event); } });
    const query = (sql: string, customerId = customerA) => service!.forContext(context(customerId)).callTool('records', 'query_database', { query: sql });
    const waitForReaderLock=async()=>{const deadline=Date.now()+450;while(Date.now()<deadline){const waiting=await admin.query("SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND application_name='eldhall-database-investigation' AND wait_event_type='Lock'",[role]);if(waiting.rows.length)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Fixture must observe the owned reader waiting for its relation probe');};
    await t.test('schema contains only approved columns and real joins/aggregates see exactly the authenticated customer', async () => {
      const described = await service!.forContext(context()).callTool('records', 'describe_database', {});
      assert.doesNotMatch(JSON.stringify(described), /private_note|private-own|foreign-customer/);
      const result = await query('SELECT a.label,sum(t.amount) AS total,count(*) AS n FROM accounts a JOIN transactions t ON a.id=t.account_id GROUP BY a.label') as { columns: { name: string }[]; rows: string[][]; rowCount: number };
      assert.equal(result.rowCount, 1); assert.deepEqual(result.rows, [['own', '30.50', '2']]);
      const foreign = await query('SELECT sum(t.amount) AS total FROM accounts a JOIN transactions t ON a.id=t.account_id', customerB) as { rows: string[][] };
      assert.deepEqual(foreign.rows, [['9999']]);
      const hidden = await query('SELECT private_note FROM accounts').then(() => 'unexpected', error => error.code); assert.equal(hidden, 'unavailable');
      assert.equal(activities.filter(event => event.type === 'guard' && event.outcome === 'succeeded').length >= 3, true);
      assert.doesNotMatch(JSON.stringify(activities), /SELECT|private-|30\.50|9999/);
    });
    await t.test('model scope settings, writes, catalogs and dangerous functions never reach dispatch', async () => {
      for (const sql of ['SELECT set_config(\'app.customer_id\',\'foreign\',true) FROM accounts', 'SELECT * FROM pg_catalog.pg_roles', 'DELETE FROM accounts', 'WITH x AS (DELETE FROM accounts RETURNING *) SELECT * FROM x']) await assert.rejects(query(sql), /invalid_query/);
      assert.equal((await admin.query(`SELECT count(*)::int n FROM "${schema}".accounts`)).rows[0].n, 3);
    });
    await t.test('row, byte and cell bounds are explicit, policy changes fence results and total turn budget holds', async () => {
      policy.limits.maxRows = 2;
      const bounded = await query('SELECT body FROM documents ORDER BY id') as { rows: string[][]; rowCount: number; truncated: boolean };
      assert.equal(bounded.rowCount, 2); assert.equal(bounded.rows[0]![0]!.length, 2048); assert.equal(bounded.truncated, true);
      policy.limits.maxBytes = 1024;
      const bytes = await query('SELECT body FROM documents') as { rowCount: number; truncated: boolean }; assert.equal(bytes.rowCount, 0); assert.equal(bytes.truncated, true);
      policy.limits = { ...DEFAULT_DATABASE_LIMITS, maxQueriesPerTurn: 1 };
      const turn = service!.forContext(context()); await turn.callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }); await assert.rejects(turn.callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }), /limit_exceeded/);
      const stale = service!.forContext({ ...context(), assertActive: async () => { policy.version++; } }); await assert.rejects(stale.callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }), /stale_policy/);
      policy.limits = { ...DEFAULT_DATABASE_LIMITS };
    });
    await t.test('deployment-owned external ID maps work and a missing map entry fails closed', async () => {
      const mapped = createDatabaseInvestigationService({ sources: [{ config: { ...source, upstreamBusinessId: businessB, customerIdMap: { [customerB]: customerA } }, pool: reader! }], getPolicy: async () => structuredClone(policy) });
      const result = await mapped.forContext(context(customerB)).callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }) as { rows: string[][] }; assert.deepEqual(result.rows, [['foreign-business']]);
      await assert.rejects(mapped.forContext(context(customerA)).callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }), /scope_unavailable/);
    });
    await t.test('writable/owner roles, RLS functions and unproven parent keys fail before any business result', async () => {
      const elevated = createDatabaseInvestigationService({ sources: [{ config: source, pool: new pg.Pool(base) }], getPolicy: async () => structuredClone(policy) });
      try { await assert.rejects(elevated.forContext(context()).callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }), /role_not_readonly/); } finally { await elevated.close(); }
      await admin.query(`ALTER TABLE "${schema}".accounts ENABLE ROW LEVEL SECURITY; CREATE POLICY unreviewed ON "${schema}".accounts USING(true)`);
      await assert.rejects(query('SELECT label FROM accounts'), /scope_unavailable|invalid_query/);
      await admin.query(`DROP POLICY unreviewed ON "${schema}".accounts; ALTER TABLE "${schema}".accounts DISABLE ROW LEVEL SECURITY; ALTER TABLE "${schema}".transactions DROP CONSTRAINT transactions_account_id_fkey`);
      await assert.rejects(query('SELECT amount FROM transactions'), /scope_unavailable/);
      await admin.query(`ALTER TABLE "${schema}".transactions ADD FOREIGN KEY(account_id) REFERENCES "${schema}".accounts(id)`);
    });
    await t.test('catalog lock waits time out and cancellation destroys only the owned read connection', async () => {
      const blocker = await admin.connect();
      try {
        await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE "${schema}".accounts IN ACCESS EXCLUSIVE MODE`);
        const result = query('SELECT label FROM accounts'); await assert.rejects(result, /timeout|unavailable/);
        const controller = new AbortController(); const aborted = service!.forContext(context()).callTool('records', 'query_database', { query: 'SELECT label FROM accounts' }, controller.signal); setTimeout(() => controller.abort(), 30); await assert.rejects(aborted, /cancelled/);
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      const after = await query('SELECT label FROM accounts') as { rows: string[][] }; assert.deepEqual(after.rows, [['own']]);
    });
    await t.test('preflight search_path is trusted and partial/expression indexes are refused',async()=>{
      await admin.query(`CREATE FUNCTION "${schema}"."left"(text,integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$SELECT 'SHADOW_CALLED'::text$$; COMMENT ON COLUMN "${schema}".accounts.label IS 'Approved account label'`);
      await reader!.query(`SET search_path="${schema}",pg_catalog`);
      const described=await service!.forContext(context()).callTool('records','describe_database',{});assert.doesNotMatch(JSON.stringify(described),/SHADOW_CALLED/);assert.match(JSON.stringify(described),/Approved account label/);
      await admin.query(`CREATE INDEX rejected_expression ON "${schema}".accounts((lower(label)))`);
      await assert.rejects(query('SELECT label FROM accounts'),/scope_unavailable/);
      await admin.query(`DROP INDEX "${schema}".rejected_expression`);
    });
    await t.test('concurrent replacement is rechecked after a nonexecuted column-only relation probe',async()=>{
      await admin.query(`CREATE FUNCTION "${schema}".view_trap(uuid) RETURNS text LANGUAGE plpgsql AS $$BEGIN RAISE NOTICE 'SYNTHETIC_FUNCTION_CALLED'; RETURN 'not-an-observation'; END$$`);
      const blocker=await admin.connect();
      try {
        await blocker.query('BEGIN');await blocker.query(`LOCK TABLE "${schema}".accounts IN ACCESS EXCLUSIVE MODE`);
        const pending=query('SELECT label FROM accounts');const settled=pending.then(value=>({value,error:null}),error=>({value:null,error}));
        await waitForReaderLock();
        await blocker.query(`ALTER TABLE "${schema}".accounts RENAME TO accounts_saved; CREATE VIEW "${schema}".accounts AS SELECT id,business_id,customer_id,"${schema}".view_trap(id) label FROM "${schema}".accounts_saved; GRANT SELECT(id,business_id,customer_id,label) ON "${schema}".accounts TO "${role}"`);
        await blocker.query('COMMIT');const result=await settled;assert.equal(result.value,null);assert.ok(['scope_unavailable','unavailable'].includes(result.error.code));assert.equal(functionNotices,0,'Preparing the probe must not execute the function-bearing replacement');
      } finally {await blocker.query('ROLLBACK');blocker.release();await admin.query(`DROP VIEW IF EXISTS "${schema}".accounts; ALTER TABLE "${schema}".accounts_saved RENAME TO accounts`);}
      assert.deepEqual((await query('SELECT label FROM accounts') as {rows:string[][]}).rows,[['own']]);
    });
    await t.test('a policy change during a blocked read prevents delivery of old-policy data',async()=>{
      const blocker=await admin.connect();try{
        await blocker.query('BEGIN');await blocker.query(`LOCK TABLE "${schema}".accounts IN ACCESS EXCLUSIVE MODE`);
        const pending=query('SELECT label FROM accounts');const settled=pending.catch(error=>error);
        await waitForReaderLock();policy.enabled=false;policy.version++;await blocker.query('COMMIT');
        const refused = await settled; assert.ok(refused instanceof Error && 'code' in refused); assert.equal(refused.code,'stale_policy');
      } finally {await blocker.query('ROLLBACK');blocker.release();policy.enabled=true;policy.version++;}
    });
  } finally {
    if (service) await service.close(); else if (reader) await reader.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  }
});
