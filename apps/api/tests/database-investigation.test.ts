import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { compileDatabaseQuery } from '../src/modules/database/compiler.js';
import { databaseInvestigationPolicySchema, databaseInvestigationSourceSchema, DEFAULT_DATABASE_LIMITS, type DatabaseRelation } from '../src/modules/database/contracts.js';
import { createDatabaseInvestigationService } from '../src/modules/database/service.js';

const businessId='10000000-0000-4000-8000-000000000001',customerId='20000000-0000-4000-8000-000000000001';
const config=databaseInvestigationSourceSchema.parse({id:'records',label:'Customer records',businessId,credentialEnv:'TEST_READ_DATABASE'});
const column=(name:string,type='text',oid=25)=>({name,type,oid,description:null});
const relations:DatabaseRelation[]=[{name:'accounts',oid:1,ownership:{kind:'columns',customerColumn:'customer_id',businessColumn:'business_id'},columns:[column('id','uuid',2950),column('customer_id','uuid',2950),column('business_id','uuid',2950),column('status')]},{name:'transactions',oid:2,ownership:{kind:'parent',parentTable:'accounts',foreignKey:'account_id',parentKey:'id'},columns:[column('id','uuid',2950),column('account_id','uuid',2950),column('amount','numeric',1700),column('posted_at','timestamp',1114)]}];
const compile=(query:string)=>compileDatabaseQuery(query,config,relations,{businessId,customerId},100);

test('database compiler scopes joins and aggregates with materialized trusted inputs without column casts',()=>{
  const value=compile("SELECT a.id, sum(t.amount) AS total FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id WHERE a.status='active' GROUP BY a.id ORDER BY total DESC LIMIT 10");
  assert.deepEqual(value.relations,['accounts','transactions']);assert.deepEqual(value.values,[businessId,customerId,'active',10]);
  assert.match(value.text,/AS MATERIALIZED/g);assert.match(value.text,/FROM ONLY "public"\."accounts"/);assert.match(value.text,/"business_id" = \$1::pg_catalog.text::pg_catalog\."uuid"/);
  assert.doesNotMatch(value.text,/"business_id"::/);assert.match(value.text,/IN \(SELECT "id" FROM "__eldhall_scope_0"\)/);
  assert.match(value.text,/pg_catalog\."sum"/);assert.doesNotMatch(value.text,/'active'/);assert.match(value.text,/LIMIT 101$/);
});

test('every nested relation is scoped; stars expand only explicitly selected columns',()=>{
  const value=compile('SELECT a.* FROM (SELECT id,status FROM accounts) a WHERE a.id IN (SELECT account_id FROM transactions)');
  assert.deepEqual(value.columns,['id','status']);assert.equal(value.relations.length,2);
  assert.doesNotMatch(value.text,/SELECT \*/);assert.match(value.text,/"a"\."id","a"\."status"/);
  assert.match(compile('SELECT count(*) FROM accounts').text,/pg_catalog\."count"\(\*\)/);
  const text=compile("SELECT id FROM accounts WHERE status='x''; DROP TABLE accounts; --'");
  assert.equal(text.values[2],"x'; DROP TABLE accounts; --");assert.doesNotMatch(text.text,/DROP TABLE/);
});

test('unsupported SQL surfaces fail closed rather than forwarding raw text or scope parameter indices',()=>{
  for(const query of [
    'SELECT * FROM accounts; SELECT * FROM transactions','WITH accounts AS (SELECT * FROM transactions) SELECT * FROM accounts',
    'SELECT * FROM pg_catalog.pg_authid','SELECT * FROM information_schema.tables','SELECT * FROM unknown_table',
    'SELECT * FROM accounts FOR UPDATE','SELECT * INTO new_table FROM accounts','SELECT set_config(\'app.customer_id\',\'foreign\',true) FROM accounts',
    'SELECT pg_sleep(10) FROM accounts','SELECT custom.read_secret() FROM accounts','SELECT pg_read_file(\'/private\') FROM accounts',
    'SELECT status::custom.domain FROM accounts','SELECT $1 FROM accounts','SELECT status OPERATOR(custom.=) status FROM accounts',
    'SELECT * FROM generate_series(1,1000000)','SELECT to_json(accounts) FROM accounts','SELECT ctid FROM accounts UNION SELECT ctid FROM accounts',
    'DELETE FROM accounts','COPY accounts TO STDOUT','SELECT count(*) OVER() FROM accounts','SELECT * FROM accounts TABLESAMPLE SYSTEM(10)',
    'SELECT amount FROM transactions WHERE amount=9007199254740993','SELECT amount FROM transactions WHERE amount=0.100000000000000000001',
  ]) assert.throws(()=>compile(query),error=>error instanceof Error&&error.message==='Database investigation refused: invalid_query',query);
});

test('quoted decimal comparisons retain exact literal bytes instead of JavaScript rounding',()=>{
  const compiled=compile("SELECT amount FROM transactions WHERE amount > '0.100000000000000000001'");
  assert.equal(compiled.values[2],'0.100000000000000000001');
});

test('database policy bounds and explicit parent ownership reject ambiguous configuration',()=>{
  assert.equal(databaseInvestigationPolicySchema.safeParse({enabled:true,limits:{...DEFAULT_DATABASE_LIMITS,maxQueriesPerTurn:13}}).success,false);
  assert.equal(databaseInvestigationSourceSchema.safeParse({...config,relations:[{table:'accounts',ownership:{kind:'parent',parentTable:'accounts',foreignKey:'id',parentKey:'id'}}]}).success,false);
});

test('disabled/invalid policy and foreign source fail before any database connection',async t=>{
  const pool=new pg.Pool();const connect=t.mock.method(pool,'connect',async()=>{throw new Error('Must not connect');});
  const service=createDatabaseInvestigationService({sources:[{config,pool}],getPolicy:async()=>({version:1,enabled:false,limits:DEFAULT_DATABASE_LIMITS})});
  const scoped=service.forContext({businessId,customerId,assertActive:async()=>undefined});
  assert.deepEqual(await scoped.listTools!(),[]);await assert.rejects(scoped.callTool('records','query_database',{query:'SELECT * FROM accounts'}),/disabled/);assert.equal(connect.mock.callCount(),0);
  assert.deepEqual(service.getSources('foreign-business'),[]);await assert.rejects(scoped.callTool('foreign','describe_database',{}),/disabled/);
  await service.close();
});

test('connector concurrency reservation is atomic after asynchronous ownership checks and errors are redacted',async t=>{
  const pool=new pg.Pool();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const connect=t.mock.method(pool,'connect',async()=>{await gate;throw new Error('synthetic-private-connection-secret');});
  const audits:unknown[]=[];const service=createDatabaseInvestigationService({sources:[{config,pool}],getPolicy:async()=>({version:1,enabled:true,limits:DEFAULT_DATABASE_LIMITS}),onAudit:async event=>{audits.push(event);}});
  let arrive=0,open!:()=>void;const barrier=new Promise<void>(resolve=>{open=resolve;});
  const run=()=>service.forContext({businessId,customerId,assertActive:async()=>{if(++arrive===3)open();await barrier;}}).callTool('records','query_database',{query:'SELECT * FROM accounts'});
  const pending=Promise.allSettled([run(),run(),run()]);await new Promise(resolve=>setImmediate(resolve));assert.equal(connect.mock.callCount(),2);release();
  const results=await pending;assert.ok(results.every(result=>result.status==='rejected'));assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='limit_exceeded').length,1);
  assert.doesNotMatch(JSON.stringify(audits),/synthetic-private|SELECT|connection-secret/);await service.close();
});
