import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { argsHash } from '../src/modules/agent/harness.js';
import { migrateSupport } from '../src/modules/support/migrations.js';
import { PostgresSupportStore } from '../src/modules/support/postgres-store.js';
import { seedData } from '../src/modules/support/seed.js';

test('real PostgreSQL request catalog persistence, transactional links and concurrent fences', {timeout:60000}, async t=>{
  const required=(key:string)=>{const value=process.env[key];if(!value)throw Error('Explicit TEST_POSTGRES_* fixture inputs are required');return value;};
  const connection={host:required('TEST_POSTGRES_HOST'),port:Number(required('TEST_POSTGRES_PORT')),database:required('TEST_POSTGRES_DB'),user:required('TEST_POSTGRES_USER'),password:required('TEST_POSTGRES_PASSWORD'),options:'',connectionTimeoutMillis:3000};
  assert.equal(connection.host,'127.0.0.1');assert.ok(Number.isInteger(connection.port)&&connection.port>0&&connection.port<=65535);
  const schema='customer_requests_'+randomUUID().replaceAll('-','');const admin=new pg.Pool(connection);let pool:pg.Pool|undefined;
  try {
    await admin.query('CREATE SCHEMA '+schema);pool=new pg.Pool({...connection,options:'-c search_path='+schema,max:10});
    await t.test('0009 alone preserves populated prior support schema and repeated application adds no inferred requests',async()=>{
      const client=await pool!.connect();
      try {await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('support-schema-v1'))");
        for(const name of ['0002_support','0003_support_turns','0004_classification','0005_insights','0006_knowledge','0007_external_knowledge','0008_integrations']) await client.query(await readFile(new URL('../migrations/'+name+'.sql',import.meta.url),'utf8'));
        await client.query('COMMIT');
      } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
      const legacy=new PostgresSupportStore(pool!);await legacy.seedIfEmpty(seedData());const seed=seedData();
      const old={id:randomUUID()};await pool!.query("INSERT INTO support_cases(id,business_id,customer_id,status,priority) VALUES($1,$2,$3,'open','P3')",[old.id,seed.businesses[0]!.id,seed.customers[0]!.id]);
      await pool!.query("INSERT INTO support_messages(id,case_id,role,body) VALUES($1,$2,'customer','Existing historical question')",[randomUUID(),old.id]);
      const args={payment_id:seed.payments[1]!.id,amount_cents:49900};await pool!.query("INSERT INTO support_proposals(id,case_id,tool,args,args_hash,risk,status,policy) VALUES($1,$2,'refund_payment',$3,$4,'high','pending',$5)",[randomUUID(),old.id,JSON.stringify(args),argsHash(old.id,'refund_payment',args),JSON.stringify({allowed:true,requiresApproval:true,checks:[]})]);
      const snapshot=async()=>{const rows=[];for(const table of ['support_cases','support_messages','support_proposals','support_payments','support_customers','support_businesses']) rows.push((await pool!.query('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),\'[]\'::jsonb)::text AS content FROM '+table+' t')).rows[0].content);return rows;};
      const before=await snapshot();const sql=await readFile(new URL('../migrations/0009_customer_requests.sql',import.meta.url),'utf8');
      for(let attempt=0;attempt<2;attempt++){const connection=await pool!.connect();try{await connection.query('BEGIN');await connection.query("SELECT pg_advisory_xact_lock(hashtext('support-schema-v1'))");await connection.query(sql);await connection.query('COMMIT');}catch(error){await connection.query('ROLLBACK');throw error;}finally{connection.release();}}
      assert.deepEqual(await snapshot(),before);assert.deepEqual((await legacy.requestCatalog(old.id)).requests,[]);assert.equal((await legacy.requestCatalog(old.id)).syncState,'needs_review');assert.equal((await legacy.proposals(old.id)).length,1);
    });
    await migrateSupport(pool);await migrateSupport(pool);
    const store=new PostgresSupportStore(pool);await store.seedIfEmpty(seedData());const seed=seedData();
    const c=await store.createCase(seed.businesses[0]!.id,seed.customers[0]!.id);const message=await store.addMessage(c.id,'customer','Return duplicate charge');const lease=(await store.acquireTurn(c.id,randomUUID()))!;
    const batch={version:0,syncState:'current' as const,changes:[{localKey:'refund',title:'Refund',goal:'Refund duplicate charge',waitingOn:null,nextStep:null,sourceMessageIds:[message.id],dependencyIds:[],dependencyKeys:[]}]};
    const first=await store.requestCheckpoint(lease,message.id,batch);const request=first.requests[0]!;
    await t.test('accepted checkpoint survives a new store and retries without duplicate requests/events',async()=>{
      const restarted=new PostgresSupportStore(pool!);assert.deepEqual(await restarted.requestCatalog(c.id),first);assert.deepEqual(await restarted.requestCheckpoint(lease,message.id,batch),first);
      assert.equal((await pool!.query('SELECT count(*)::int AS n FROM support_request_events WHERE case_id=$1',[c.id])).rows[0].n,1);
      await assert.rejects(restarted.requestCheckpoint(lease,message.id,{...batch,syncState:'needs_review'}));
    });
    const args={payment_id:seed.payments[1]!.id,amount_cents:49900};const value={caseId:c.id,tool:'refund_payment',args,argsHash:argsHash(c.id,'refund_payment',args),risk:'high' as const,status:'pending' as const,policy:{allowed:true,requiresApproval:true,checks:[]}};
    await t.test('proposal creation rolls back entirely if its request revision is stale',async()=>{
      await assert.rejects(store.createProposal(value,lease,[{id:request.id,revision:9}]));assert.equal((await store.proposals(c.id)).length,0);
    });
    const p=await store.createProposal(value,lease,[{id:request.id,revision:1}]);await store.decideProposal(p.id,p.argsHash,'approved','operator:test');
    await t.test('source-only checkpoint does not invalidate approval; one execution claim wins',async()=>{
      const source=await store.addMessage(c.id,'customer','Same goal');const current=await store.requestCatalog(c.id);
      const next=await store.requestCheckpoint(lease,source.id,{...batch,version:current.version,changes:[{...batch.changes[0]!,id:request.id,expectedRevision:1,sourceMessageIds:[source.id]}]});
      assert.equal(next.requests[0]!.revision,1);assert.equal((await store.proposal(p.id))!.status,'approved');
      const outcomes=await Promise.all([store.claimExecution(p.id,p.argsHash,'operator:a'),store.claimExecution(p.id,p.argsHash,'operator:b')]);assert.equal(outcomes.filter(Boolean).length,1);
    });
    await t.test('old-revision unknown effect remains durable and blocks new-revision admission',async()=>{
      await store.finishProposal(p.id,'unknown',null,'Synthetic uncertain outcome');const source=await store.addMessage(c.id,'customer','Different goal');const current=await store.requestCatalog(c.id);
      await store.requestCheckpoint(lease,source.id,{...batch,version:current.version,changes:[{...batch.changes[0]!,id:request.id,expectedRevision:1,goal:'Different refund goal',sourceMessageIds:[source.id]}]});
      const next=await store.createProposal(value,lease,[{id:request.id,revision:2}]);assert.equal(await store.decideProposal(next.id,next.argsHash,'approved','operator:test'),null);
      const catalog=await store.requestCatalog(c.id);await assert.rejects(store.requestTransition(c.id,request.id,{version:catalog.version,revision:2,transition:'cancel',reason:'Cannot clear unknown',proof:{proposalIds:[],messageIds:[]}},'operator:test'));
      assert.equal((await new PostgresSupportStore(pool!).proposal(p.id))!.status,'unknown');
    });
    await t.test('takeover revokes the catalog writer and leaves prior history intact',async()=>{
      await store.setOwnership(c.id,'staff','operator:test');const before=await store.requestCatalog(c.id);const source=await store.addMessage(c.id,'customer','After takeover');
      await assert.rejects(store.requestCheckpoint(lease,source.id,{version:before.version,syncState:'needs_review',changes:[]}));const after=await store.requestCatalog(c.id);assert.deepEqual(after.requests,before.requests);assert.deepEqual(after.history,before.history);assert.equal(after.version,before.version);assert.equal(after.syncState,'needs_review');
    });
    await t.test('current migration runner preserves actual catalog checkpoints and immutable events',async()=>{
      const before=await store.requestCatalog(c.id);await migrateSupport(pool!);await migrateSupport(pool!);assert.deepEqual(await store.requestCatalog(c.id),before);
    });
    await t.test('failed ticket resolution preserves queued jobs; evidenced request CAS has one winner and reopening reopens ticket',async()=>{
      const other=await store.createCase(seed.businesses[0]!.id,seed.customers[0]!.id);const source=await store.addMessage(other.id,'customer','Please verify my contact record');const turn=(await store.acquireTurn(other.id,randomUUID()))!;
      const first=await store.requestCheckpoint(turn,source.id,{version:0,syncState:'current',changes:[{...batch.changes[0]!,title:'Verify contact',goal:'Verify contact',sourceMessageIds:[source.id]}]});const target=first.requests[0]!;await store.releaseTurn(turn);
      const accepted=await store.enqueueTurn(other.id,seed.customers[0]!.id,'A later customer message',randomUUID());const beforeCase=await store.getCase(other.id);const beforeJob=await store.activeTurnJob(other.id);
      await assert.rejects(store.resolveCase(other.id,'operator:test',beforeCase!.ownershipVersion));assert.deepEqual(await store.getCase(other.id),beforeCase);assert.deepEqual(await store.activeTurnJob(other.id),beforeJob);assert.equal(beforeJob!.id,accepted.job!.id);
      const jobLease=(await store.claimTurnJob(accepted.job!.id,'request-test-worker'))!.lease;
      await store.requestCheckpoint(jobLease,accepted.message.id,{version:first.version,syncState:'current',changes:[{...batch.changes[0]!,id:target.id,expectedRevision:target.revision,title:'Verify contact',goal:'Verify contact',sourceMessageIds:[accepted.message.id]}]});
      const owned=await store.setOwnership(other.id,'staff','operator:test');const confirmation=await store.staffMessage(other.id,'I verified the requested contact record',owned.ownershipVersion);const catalog=await store.requestCatalog(other.id);
      const body={version:catalog.version,revision:target.revision,transition:'fulfill' as const,reason:'Verified in the recorded operator note',proof:{proposalIds:[],messageIds:[confirmation.id]}};
      const results=await Promise.allSettled([store.requestTransition(other.id,target.id,body,'operator:a'),store.requestTransition(other.id,target.id,body,'operator:b')]);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await store.getCase(other.id))!.status,'resolved');
      const closed=await store.requestCatalog(other.id);await store.requestTransition(other.id,target.id,{version:closed.version,revision:closed.requests[0]!.revision,transition:'reopen',reason:'The customer still needs help',proof:{proposalIds:[],messageIds:[]}},'operator:test');assert.notEqual((await store.getCase(other.id))!.status,'resolved');
      const reopened=await store.requestCatalog(other.id);await store.requestTransition(other.id,target.id,{version:reopened.version,revision:reopened.requests[0]!.revision,transition:'cancel',reason:'Operator closes the reviewed request',proof:{proposalIds:[],messageIds:[]}},'operator:test');assert.equal((await store.getCase(other.id))!.status,'resolved');
      const prior=(await store.getCase(other.id))!;const incoming=await store.enqueueTurn(other.id,seed.customers[0]!.id,'A new unanswered customer request',randomUUID());assert.equal(incoming.job,null);assert.equal(incoming.case.status,'escalated');assert.equal((await store.getCase(other.id))!.ownershipVersion,prior.ownershipVersion);assert.equal((await store.requestCatalog(other.id)).syncState,'needs_review');
    });
  } finally {await pool?.end();try{await admin.query('DROP SCHEMA '+schema+' CASCADE');}finally{await admin.end();}}
});
