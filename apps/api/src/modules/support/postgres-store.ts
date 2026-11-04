import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AgentRun, AuditEvent, Business, CaseStatus, Customer, KnowledgeSource, Message, MessageRole, Metrics, Payment, Proposal, Refund, SupportCase, SupportSettings, SupportSkill, TurnLease } from './contracts.js';
import { PostgresTurnJobs } from './postgres-turn-jobs.js';
import type { SeedData } from './seed.js';
import { AUTO_CLAIMABLE, DuplicateRefund, StaleTurn, VersionConflict, type CasePatch, type NewProposal, type SupportStore, type TurnContext } from './store.js';
import { sameClassificationConfig } from '../agent/classification.js';
import { canReplaceClassification, classificationState, storedClassification, visibleClassification, type StoredClassification } from './classification-storage.js';
import { PostgresIntegrationStore, externalAdmissionReason, lockIntegration, type IntegrationState } from '../../integrations/state.js';
type StoredSettings = Omit<SupportSettings, 'classification'> & { classification?: StoredClassification };

type Queryable = Pick<pg.Pool,'query'>;
const json=(value:unknown)=>JSON.stringify(value);
const map=<T>(row:Record<string,unknown>):T=>Object.fromEntries(Object.entries(row).filter(([key])=>!['active_run_id','active_run_at'].includes(key)).map(([key,value])=>[key.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),value instanceof Date?value.toISOString():value])) as T;
const first=<T>(rows:Record<string,unknown>[])=>rows[0]?map<T>(rows[0]):null;
const caseSelect='SELECT c.*,u.name AS customer_name FROM support_cases c JOIN support_customers u ON u.id=c.customer_id';
export class PostgresSupportStore implements SupportStore {
  private readonly turnJobs: PostgresTurnJobs;
  readonly integrationStore: PostgresIntegrationStore;
  constructor(private readonly pool:pg.Pool) { this.turnJobs = new PostgresTurnJobs(pool); this.integrationStore = new PostgresIntegrationStore(pool); }
  enqueueTurn(caseId:string,customerId:string,body:string,clientMessageId?:string) { return this.turnJobs.enqueue(caseId,customerId,body,clientMessageId); }
  pendingTurnJobs(limit?:number) { return this.turnJobs.pending(limit); }
  activeTurnJob(caseId:string) { return this.turnJobs.active(caseId); }
  claimTurnJob(id:string,workerId:string) { return this.turnJobs.claim(id,workerId); }
  heartbeatTurnJob(lease:TurnLease) { return this.turnJobs.heartbeat(lease); }
  failTurnJob(lease:TurnLease,error:string,retry:boolean) { return this.turnJobs.fail(lease,error,retry); }
  private async transaction<T>(run:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    try { await client.query('BEGIN'); const result=await run(client); await client.query('COMMIT'); return result; }
    catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async seed(client:Queryable,seed:SeedData) {
    for (const b of seed.businesses) await client.query('INSERT INTO support_businesses(id,slug,name,currency,policy) VALUES($1,$2,$3,$4,$5)',[b.id,b.slug,b.name,b.currency,json(b.policy)]);
    for (const c of seed.customers) await client.query('INSERT INTO support_customers(id,business_id,name,email,plan,session_token) VALUES($1,$2,$3,$4,$5,$6)',[c.id,c.businessId,c.name,c.email,c.plan,c.sessionToken]);
    for (const p of seed.payments) await client.query('INSERT INTO support_payments(id,customer_id,amount_cents,currency,merchant_ref,description,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[p.id,p.customerId,p.amountCents,p.currency,p.merchantRef,p.description,p.status,p.createdAt]);
  }
  async reset(seed:SeedData) { await this.transaction(async client=> { await client.query("SELECT pg_advisory_xact_lock(hashtext('support-seed'))"); await client.query('TRUNCATE support_external_executions,support_integration_audit,support_integration_manifests,support_integrations,support_knowledge_versions,support_insight_runs,support_turn_jobs,support_settings,support_skills,support_knowledge,support_agent_runs,support_audit_events,support_refunds,support_payment_executions,support_proposals,support_messages,support_cases,support_payments,support_customers,support_businesses'); await this.seed(client,seed); }); }
  async seedIfEmpty(seed:SeedData) { await this.transaction(async client=> { await client.query("SELECT pg_advisory_xact_lock(hashtext('support-seed'))"); if (!(await client.query('SELECT 1 FROM support_businesses LIMIT 1')).rowCount) await this.seed(client,seed); }); }
  async recoverInterruptedExecutions() {
    await this.expireExternalActions();
    const interrupted = await this.pool.query("SELECT p.id,e.status FROM support_proposals p JOIN support_external_executions e ON e.action_id=p.id WHERE p.status='executing' AND p.decided_at<now()-interval '180 seconds'");
    for (const row of interrupted.rows) await this.finishExternalAction(row.id, row.status==='admitted'?'failed':'unknown', null, row.status==='admitted'?'interrupted_before_dispatch':'interrupted_after_dispatch', 'Результат зовнішньої дії потребує перевірки спеціалістом. Автоматичний повтор заблоковано.', 'system:recovery');
    await this.transaction(async client=> {
      const rows=await client.query("UPDATE support_proposals SET status='unknown',error='Execution confirmation was interrupted; manual reconciliation required' WHERE tool<>'external_action' AND status='executing' AND decided_at<now()-interval '180 seconds' RETURNING id,case_id");
      for(const row of rows.rows) await client.query("INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,'action.unknown','system:recovery',$3)",[randomUUID(),row.case_id,json({proposalId:row.id})]);
    });
  }
  async businessesList() { return (await this.pool.query('SELECT * FROM support_businesses ORDER BY slug')).rows.map(r=>map<Business>(r)); }
  async createBusiness(business:Business) {
    try { return map<Business>((await this.pool.query('INSERT INTO support_businesses(id,slug,name,currency,policy) VALUES($1,$2,$3,$4,$5) RETURNING *',[business.id,business.slug,business.name,business.currency,json(business.policy)])).rows[0]); }
    catch(error) { if(error && typeof error==='object' && 'code' in error && error.code==='23505') throw new VersionConflict('Business slug already exists');throw error; }
  }
  async createCustomer(customer:Customer) { return map<Customer>((await this.pool.query('INSERT INTO support_customers(id,business_id,name,email,plan,session_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[customer.id,customer.businessId,customer.name,customer.email,customer.plan,customer.sessionToken])).rows[0]); }
  async customerBySession(token:string) { return first<Customer>((await this.pool.query('SELECT * FROM support_customers WHERE session_token=$1',[token])).rows); }
  async customer(id:string) { return first<Customer>((await this.pool.query('SELECT * FROM support_customers WHERE id=$1',[id])).rows); }
  async business(id:string) { return first<Business>((await this.pool.query('SELECT * FROM support_businesses WHERE id=$1',[id])).rows); }
  async payments(customerId:string,limit=10) { return (await this.pool.query('SELECT * FROM support_payments WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT $2',[customerId,limit])).rows.map(r=>map<Payment>(r)); }
  async payment(id:string) { return first<Payment>((await this.pool.query('SELECT * FROM support_payments WHERE id=$1',[id])).rows); }
  async createCase(businessId:string,customerId:string) {
    const id=randomUUID(); await this.pool.query("INSERT INTO support_cases(id,business_id,customer_id,status,priority) VALUES($1,$2,$3,'open','P3')",[id,businessId,customerId]);
    return (await this.getCase(id))!;
  }
  async getCase(id:string) { return first<SupportCase>((await this.pool.query(caseSelect+' WHERE c.id=$1',[id])).rows); }
  async listCases(status?:CaseStatus) { return (await this.pool.query(caseSelect+' WHERE ($1::text IS NULL OR c.status=$1) ORDER BY c.priority,c.updated_at DESC,c.id',[status??null])).rows.map(r=>map<SupportCase>(r)); }
  private async patch(client:Queryable,id:string,patch:CasePatch) {
    const keys=Object.keys(patch) as (keyof CasePatch)[];
    const columns:Record<keyof CasePatch,string>={status:'status',priority:'priority',intent:'intent',analysis:'analysis',ownership:'ownership',assignedTo:'assigned_to'};
    const values=keys.map(k=>k==='analysis'?json(patch[k]):patch[k]);
    const sets=keys.map((k,i)=>columns[k]+'=$'+(i+2));
    await client.query('UPDATE support_cases SET '+[...sets,'updated_at=now()'].join(',')+' WHERE id=$1',[id,...values]);
  }
  async updateCase(id:string,patch:CasePatch) { await this.patch(this.pool,id,patch); const row=await this.getCase(id); if (!row) throw new Error('Case not found'); return row; }
  async setOwnership(id:string,ownership:'bot'|'staff',actor:string,expectedVersion?:number) {
    await this.transaction(async client=> {
      const result=await client.query('UPDATE support_cases SET ownership=$2,ownership_version=ownership_version+1,assigned_to=$3,active_run_id=NULL,active_run_at=NULL,updated_at=now() WHERE id=$1 AND ($4::int IS NULL OR ownership_version=$4) RETURNING id',[id,ownership,ownership==='staff'?actor:null,expectedVersion??null]);
      if (!result.rowCount) throw new VersionConflict('Conversation ownership changed');
      await client.query("UPDATE support_proposals SET status='rejected',error='Conversation ownership changed' WHERE case_id=$1 AND status IN ('pending','approved')",[id]);
      await client.query("UPDATE support_turn_jobs SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE case_id=$1 AND status IN ('queued','running')",[id]);
    });
    return (await this.getCase(id))!;
  }
  async staffMessage(id:string,body:string,expectedVersion?:number) {
    return this.transaction(async client=> {
      const result=await client.query("SELECT id FROM support_cases WHERE id=$1 AND ownership='staff' AND ($2::int IS NULL OR ownership_version=$2) FOR UPDATE",[id,expectedVersion??null]);
      if(!result.rowCount) throw new VersionConflict('Take over the current conversation before replying');
      return this.insertMessage(client,id,'operator',body);
    });
  }
  async acquireTurn(caseId:string,runId:string) {
    return this.transaction(async client=> {
      const old=await client.query("SELECT ownership_version,active_run_id FROM support_cases WHERE id=$1 AND ownership='bot' AND (active_run_id IS NULL OR active_run_at<now()-interval '180 seconds') AND NOT EXISTS(SELECT 1 FROM support_turn_jobs WHERE case_id=$1 AND status IN ('queued','running')) FOR UPDATE",[caseId]);
      if (!old.rowCount) return null;
      if(old.rows[0].active_run_id) await client.query("UPDATE support_proposals SET status='rejected',error='Previous run expired' WHERE case_id=$1 AND status IN ('pending','approved')",[caseId]);
      const result=await client.query('UPDATE support_cases SET active_run_id=$2,active_run_at=now(),ownership_version=ownership_version+$3 WHERE id=$1 RETURNING ownership_version',[caseId,runId,old.rows[0].active_run_id?1:0]);
      return {caseId,runId,ownershipVersion:Number(result.rows[0].ownership_version)};
    });
  }
  private async active(client:Queryable,lease:TurnLease,lock=false) {
    const result=await client.query("SELECT id FROM support_cases WHERE id=$1 AND active_run_id=$2 AND ownership_version=$3 AND ownership='bot' AND active_run_at>now()-interval '180 seconds'"+(lock?' FOR UPDATE':''),[lease.caseId,lease.runId,lease.ownershipVersion]);
    if (!result.rowCount) return false;
    if (lease.jobFence !== undefined) return Boolean((await client.query("SELECT id FROM support_turn_jobs WHERE id=$1 AND fence=$2 AND worker_id=$3 AND status='running' AND lease_expires_at>now()"+(lock?' FOR UPDATE':''),[lease.runId,lease.jobFence,lease.workerId])).rowCount);
    return true;
  }
  async assertTurn(lease:TurnLease) { return this.active(this.pool,lease); }
  async releaseTurn(lease:TurnLease) { await this.pool.query('UPDATE support_cases SET active_run_id=NULL,active_run_at=NULL WHERE id=$1 AND active_run_id=$2 AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM support_turn_jobs WHERE id=$2 AND fence=$3))',[lease.caseId,lease.runId,lease.jobFence??null]); }
  async completeTurn(lease:TurnLease,patch:CasePatch,body:string,sourceRefs:Message['sourceRefs']=[],context?:TurnContext) {
    return this.transaction(async client=> {
      if(context?.integrationRefs?.length) {
        const businessId=(await client.query('SELECT business_id FROM support_cases WHERE id=$1',[lease.caseId])).rows[0]?.business_id;
        if(!businessId) return null;
        for(const ref of [...context.integrationRefs].sort((a,b)=>a.integrationId.localeCompare(b.integrationId))) {
          await lockIntegration(client,businessId,ref.integrationId);
          const state=(await client.query('SELECT state FROM support_integrations WHERE business_id=$1 AND integration_id=$2',[businessId,ref.integrationId])).rows[0]?.state as IntegrationState|undefined;
          if(!state||!state.enabled||state.draining||state.activeManifestHash!==ref.manifestHash||state.connectionRevision!==ref.connectionRevision||state.policy.policyRevision!==ref.policyRevision) return null;
        }
      }
      if (!await this.active(client,lease,true)) return null;
      if(sourceRefs.length) {
        const sources=await client.query('SELECT id,version,status FROM support_knowledge WHERE business_id=(SELECT business_id FROM support_cases WHERE id=$1) AND id=ANY($2::uuid[]) FOR SHARE',[lease.caseId,sourceRefs.map(ref=>ref.id)]);
        if(sourceRefs.some(ref=>!sources.rows.some(source=>source.id===ref.id && source.version===ref.version && source.status==='published'))) return null;
      }
      if(context) {
        if(!(await client.query('SELECT id FROM support_businesses WHERE id=(SELECT business_id FROM support_cases WHERE id=$1) AND policy=$2::jsonb FOR SHARE',[lease.caseId,json(context.policy)])).rowCount) return null;
        const classifier = await client.query('SELECT classification FROM support_settings WHERE business_id=(SELECT business_id FROM support_cases WHERE id=$1) FOR SHARE', [lease.caseId]);
        if (!sameClassificationConfig(visibleClassification(classifier.rows[0]?.classification), context.classification)) return null;
        if(context.skills.length) {
          const skills=await client.query('SELECT id,revision,enabled FROM support_skills WHERE business_id=(SELECT business_id FROM support_cases WHERE id=$1) AND id=ANY($2::uuid[]) FOR SHARE',[lease.caseId,context.skills.map(ref=>ref.id)]);
          if(context.skills.some(ref=>!skills.rows.some(skill=>skill.id===ref.id && skill.revision===ref.revision && skill.enabled))) return null;
        }
      }
      await this.patch(client,lease.caseId,patch);
      if (patch.ownership==='staff') {
        await client.query("UPDATE support_cases SET ownership_version=ownership_version+1,assigned_to='queue:tier-2' WHERE id=$1",[lease.caseId]);
        await client.query("UPDATE support_proposals SET status='rejected',error='Conversation handed to staff' WHERE case_id=$1 AND status IN ('pending','approved')",[lease.caseId]);
      }
      const existingMessage=context?.completionActionId?first<Message>((await client.query('SELECT m.* FROM support_messages m JOIN support_external_executions e ON e.completion_message_id=m.id WHERE e.action_id=$1 AND m.case_id=$2',[context.completionActionId,lease.caseId])).rows):null;
      const reply=existingMessage??await this.insertMessage(client,lease.caseId,'assistant',body,sourceRefs,context?.externalSourceRefs);
      if(lease.jobFence!==undefined) {
        await client.query("UPDATE support_turn_jobs SET status='completed',worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[lease.runId]);
        await client.query('UPDATE support_cases SET active_run_id=NULL,active_run_at=NULL WHERE id=$1',[lease.caseId]);
      }
      const supportCase=first<SupportCase>((await client.query(caseSelect+' WHERE c.id=$1',[lease.caseId])).rows)!;
      return {case:supportCase,reply};
    });
  }
  private async insertMessage(client:Queryable,caseId:string,role:MessageRole,body:string,sourceRefs:Message['sourceRefs']=[],externalSourceRefs:Message['externalSourceRefs']=[]) {
    return map<Message>((await client.query('INSERT INTO support_messages(id,case_id,role,body,source_refs,external_source_refs) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),caseId,role,body,json(sourceRefs),json(externalSourceRefs)])).rows[0]);
  }
  async addMessage(caseId:string,role:MessageRole,body:string) { return this.insertMessage(this.pool,caseId,role,body); }
  async messages(caseId:string) { return (await this.pool.query('SELECT * FROM support_messages WHERE case_id=$1 ORDER BY created_at,id',[caseId])).rows.map(r=>map<Message>(r)); }
  async createProposal(proposal:NewProposal,lease?:TurnLease) {
    return this.transaction(async client=> {
      if (lease && !await this.active(client,lease,true)) throw new StaleTurn('Conversation ownership changed');
      if(lease?.jobFence!==undefined) {
        const previous=first<Proposal>((await client.query('SELECT * FROM support_proposals WHERE turn_job_id=$1 AND tool=$2',[lease.runId,proposal.tool])).rows);
        if(previous) { if(previous.argsHash!==proposal.argsHash) throw new StaleTurn('Recovered action arguments changed; staff review required');return previous; }
      }
      return map<Proposal>((await client.query('INSERT INTO support_proposals(id,case_id,tool,args,args_hash,risk,status,policy,turn_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),proposal.caseId,proposal.tool,json(proposal.args),proposal.argsHash,proposal.risk,proposal.status,json(proposal.policy),lease?.jobFence!==undefined?lease.runId:null])).rows[0]);
    });
  }
  async proposal(id:string) { return first<Proposal>((await this.pool.query('SELECT * FROM support_proposals WHERE id=$1',[id])).rows); }
  async proposals(caseId:string) { return (await this.pool.query('SELECT * FROM support_proposals WHERE case_id=$1 ORDER BY created_at,id',[caseId])).rows.map(r=>map<Proposal>(r)); }
  async decideProposal(id:string,argsHash:string,decision:'approved'|'rejected',actor:string) {
    if(decision==='approved') return this.transaction(async client=> {
      await this.lockExternal(client,id);
      const proposal=first<Proposal>((await client.query("SELECT p.* FROM support_proposals p JOIN support_cases c ON c.id=p.case_id WHERE p.id=$1 AND p.args_hash=$2 AND p.status='pending' FOR UPDATE OF p,c",[id,argsHash])).rows);
      if(!proposal || (proposal.tool==='external_action' && !await this.admitExternal(client,proposal,actor,false))) return null;
      return first<Proposal>((await client.query("UPDATE support_proposals SET status='approved',decided_by=$2,decided_at=now() WHERE id=$1 RETURNING *",[id,actor])).rows);
    });
    return first<Proposal>((await this.pool.query("UPDATE support_proposals SET status=$3,decided_by=$4,decided_at=now() WHERE id=$1 AND args_hash=$2 AND status='pending' RETURNING *",[id,argsHash,decision,actor])).rows);
  }
  async claimExecution(id:string,argsHash:string,actor:string) {
    return this.transaction(async client=> {
      await this.lockExternal(client,id);
      const proposal=first<Proposal>((await client.query("SELECT p.* FROM support_proposals p JOIN support_cases c ON c.id=p.case_id WHERE p.id=$1 AND p.args_hash=$2 AND p.status='approved' AND p.decided_at>now()-interval '15 minutes' FOR UPDATE OF p,c",[id,argsHash])).rows);
      if (!proposal) return null;
      if(proposal.tool==='external_action' && !await this.admitExternal(client,proposal,actor,true)) return null;
      if (proposal.tool==='refund_payment') {
        const result=await client.query('INSERT INTO support_payment_executions(payment_id,proposal_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[proposal.args.payment_id,proposal.id]);
        if (!result.rowCount) return null;
      }
      return map<Proposal>((await client.query("UPDATE support_proposals SET status='executing',decided_by=$2,decided_at=now(),authorization_origin=CASE WHEN tool='external_action' THEN 'operator_approval' ELSE authorization_origin END WHERE id=$1 RETURNING *",[id,actor])).rows[0]);
    });
  }
  async claimProposal(id:string,argsHash:string,to:'executing'|'rejected',actor:string) {
    if (to==='rejected') return this.decideProposal(id,argsHash,'rejected',actor);
    return this.transaction(async client=> {
      await this.lockExternal(client,id);
      const proposal=first<Proposal>((await client.query("SELECT p.* FROM support_proposals p JOIN support_cases c ON c.id=p.case_id WHERE p.id=$1 AND p.args_hash=$2 AND p.status='pending' AND p.tool=ANY($3) AND (p.policy->>'requiresApproval')='false' FOR UPDATE OF p,c",[id,argsHash,AUTO_CLAIMABLE])).rows);
      if(!proposal || (proposal.tool==='external_action' && !await this.admitExternal(client,proposal,actor,true))) return null;
      return first<Proposal>((await client.query("UPDATE support_proposals SET status='executing',decided_by=$2,decided_at=now(),authorization_origin=CASE WHEN tool='external_action' THEN 'policy_auto' ELSE authorization_origin END WHERE id=$1 RETURNING *",[id,actor])).rows);
    });
  }
  private async lockExternal(client:pg.PoolClient,id:string) {
    const row=(await client.query("SELECT p.case_id,p.tool,c.business_id,p.args->>'integrationId' AS integration_id FROM support_proposals p JOIN support_cases c ON c.id=p.case_id WHERE p.id=$1",[id])).rows[0];
    if(!row) return;
    if(row.tool==='external_action') await lockIntegration(client,row.business_id,row.integration_id);
    await client.query('SELECT id FROM support_cases WHERE id=$1 FOR UPDATE',[row.case_id]);
  }
  private async admitExternal(client:pg.PoolClient,proposal:Proposal,actor:string,claim:boolean) {
    const supportCase=map<SupportCase>((await client.query('SELECT * FROM support_cases WHERE id=$1',[proposal.caseId])).rows[0]);
    const state=(await client.query('SELECT state FROM support_integrations WHERE business_id=$1 AND integration_id=$2',[supportCase.businessId,proposal.args.integrationId])).rows[0]?.state as IntegrationState | undefined;
    const unknown=(await client.query("SELECT 1 FROM support_external_executions e JOIN support_proposals p ON p.id=e.action_id WHERE p.case_id=$1 AND e.status='unknown' AND e.action_id<>$2 LIMIT 1",[proposal.caseId,proposal.id])).rowCount;
    const reason=unknown?'unknown_execution_pending':externalAdmissionReason(proposal,supportCase,state??null);
    if(reason) { await this.terminalExternal(client,proposal,reason);return false; }
    if(claim) {
      const inserted=await client.query("INSERT INTO support_external_executions(action_id,business_id,integration_id,idempotency_key,authorization_origin,status) VALUES($1,$2,$3,$1,$4,'admitted') ON CONFLICT DO NOTHING",[proposal.id,supportCase.businessId,proposal.args.integrationId,actor==='agent:auto'?'policy_auto':'operator_approval']);
      if(!inserted.rowCount) return false;
      await client.query("INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,'action.claimed',$3,$4)",[randomUUID(),proposal.caseId,actor,json({proposalId:proposal.id,integrationId:proposal.args.integrationId,operationKey:proposal.args.operationKey,manifestHash:proposal.args.manifestHash,connectionRevision:proposal.args.connectionRevision,policyRevision:proposal.args.policyRevision,argsHash:proposal.argsHash,origin:actor==='agent:auto'?'policy_auto':'operator_approval'})]);
    }
    return true;
  }
  async markExternalDispatched(id:string) {
    return Boolean((await this.pool.query("WITH moved AS (UPDATE support_external_executions SET status='dispatched',dispatched_at=now() WHERE action_id=$1 AND status='admitted' AND EXISTS(SELECT 1 FROM support_proposals WHERE id=$1 AND status='executing') RETURNING action_id,authorization_origin) INSERT INTO support_audit_events(id,case_id,type,actor,data) SELECT $2,p.case_id,'action.dispatched',COALESCE(p.decided_by,'system'),jsonb_build_object('proposalId',p.id,'integrationId',p.args->>'integrationId','operationKey',p.args->>'operationKey','manifestHash',p.args->>'manifestHash','connectionRevision',p.args->>'connectionRevision','policyRevision',p.args->'policyRevision','argsHash',p.args_hash,'origin',m.authorization_origin) FROM moved m JOIN support_proposals p ON p.id=m.action_id RETURNING id",[id,randomUUID()])).rowCount);
  }
  async expireExternalActions() {
    const candidates=await this.pool.query("SELECT id,case_id FROM support_proposals WHERE tool='external_action' AND status IN ('pending','approved') AND args->>'expiresAt' IS NOT NULL AND (args->>'expiresAt')::timestamptz<=now()");
    for(const candidate of candidates.rows) await this.transaction(async client=>{
      await client.query('SELECT id FROM support_cases WHERE id=$1 FOR UPDATE',[candidate.case_id]);
      const expired=(await client.query("SELECT args FROM support_proposals WHERE id=$1 AND status IN ('pending','approved') AND (args->>'expiresAt')::timestamptz<=now() FOR UPDATE",[candidate.id])).rows[0];
      if(!expired) return;
      await this.terminalExternal(client,{id:candidate.id,caseId:candidate.case_id,args:expired.args},'approval_expired');
    });
  }
  private async terminalExternal(client:pg.PoolClient,proposal:Pick<Proposal,'id'|'caseId'|'args'>,reason:string) {
    const expired=reason==='approval_expired';const changed=await client.query("UPDATE support_proposals SET status=$2,error=$3 WHERE id=$1 AND status IN ('pending','approved') RETURNING id",[proposal.id,expired?'expired':'invalidated',reason]);
    if(!changed.rowCount) return;
    await this.insertMessage(client,proposal.caseId,'assistant',expired?`Строк погодження дії «${String(proposal.args.title)}» минув. Дію не виконано; звернення передано спеціалісту.`:`Дію «${String(proposal.args.title)}» не виконано: дозвіл змінився або попередній результат потребує перевірки спеціалістом.`);
    await client.query('INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,$3,$4,$5)',[randomUUID(),proposal.caseId,expired?'action.expired':'action.invalidated','system:integration',json({proposalId:proposal.id,reasonCode:reason})]);
    await client.query("UPDATE support_cases SET ownership='staff',ownership_version=ownership_version+1,assigned_to='queue:tier-2',status='escalated',active_run_id=NULL,active_run_at=NULL,updated_at=now() WHERE id=$1",[proposal.caseId]);
    await client.query("UPDATE support_proposals SET status=CASE WHEN tool='external_action' THEN 'invalidated' ELSE 'rejected' END,error='Conversation handed to staff' WHERE case_id=$1 AND status IN ('pending','approved')",[proposal.caseId]);
    await client.query("UPDATE support_turn_jobs SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE case_id=$1 AND status IN ('queued','running')",[proposal.caseId]);
  }
  async finishExternalAction(id:string,status:'executed'|'failed'|'unknown',result:Record<string,unknown>|null,error:string|null,message:string|null,actor:string,reconciliation=false) {
    return this.transaction(async client=> {
      const origin=(await client.query('SELECT case_id FROM support_proposals WHERE id=$1',[id])).rows[0];
      if(!origin) throw new Error('External execution not found');
      await client.query('SELECT id FROM support_cases WHERE id=$1 FOR UPDATE',[origin.case_id]);
      const locked=await client.query('SELECT p.*,e.status AS execution_status FROM support_proposals p JOIN support_external_executions e ON e.action_id=p.id JOIN support_cases c ON c.id=p.case_id WHERE p.id=$1 FOR UPDATE OF p,e,c',[id]);
      const executionStatus=locked.rows[0]?.execution_status;const raw=locked.rows[0]?Object.fromEntries(Object.entries(locked.rows[0]).filter(([key])=>key!=='execution_status')):null;
      const proposal=raw?map<Proposal>(raw):null;
      if(!proposal) throw new Error('External execution not found');
      if(reconciliation&&proposal.status!=='unknown') throw new VersionConflict('Execution was already reconciled');
      if(!reconciliation&&proposal.status!=='executing') return proposal;
      if(actor==='system:recovery') {
        if(!proposal.decidedAt||Date.now()-Date.parse(proposal.decidedAt)<=180000) return proposal;
        status=executionStatus==='admitted'?'failed':'unknown';error=executionStatus==='admitted'?'interrupted_before_dispatch':'interrupted_after_dispatch';
      }
      const done=map<Proposal>((await client.query('UPDATE support_proposals SET status=$2,result=$3,error=$4 WHERE id=$1 RETURNING *',[id,status,json(result),error])).rows[0]);
      let messageId:string|null=null;
      if(message) messageId=(await this.insertMessage(client,proposal.caseId,'assistant',message)).id;
      await client.query('UPDATE support_external_executions SET status=$2,result=$3,error=$4,completed_at=now(),completion_message_id=COALESCE($5::uuid,completion_message_id),provider_ref=COALESCE($6,provider_ref) WHERE action_id=$1',[id,status,json(result),error,messageId,typeof result?.providerRef==='string'?result.providerRef:null]);
      await client.query("UPDATE support_cases SET status=CASE WHEN $2='resolved' AND ownership='staff' THEN status ELSE $2 END,updated_at=now(),ownership=CASE WHEN $3 THEN 'staff' ELSE ownership END,ownership_version=ownership_version+CASE WHEN $3 THEN 1 ELSE 0 END,assigned_to=CASE WHEN $3 THEN $4 ELSE assigned_to END,active_run_id=CASE WHEN $3 THEN NULL ELSE active_run_id END,active_run_at=CASE WHEN $3 THEN NULL ELSE active_run_at END WHERE id=$1",[proposal.caseId,status==='executed'?'resolved':'escalated',!!message&&(status==='unknown'||(status!=='executed'&&actor!=='agent:auto')),actor]);
      await client.query('INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,$3,$4,$5)',[randomUUID(),proposal.caseId,reconciliation?'action.reconciled':`action.${status}`,actor,json({proposalId:id,operationKey:proposal.args.operationKey,origin:proposal.authorizationOrigin,reasonCode:error,guard:result?.guard??proposal.args.guard??null})]);
      return done;
    });
  }
  async finishProposal(id:string,status:'executed'|'failed'|'unknown',result:Record<string,unknown>|null,error:string|null) {
    const row=first<Proposal>((await this.pool.query('UPDATE support_proposals SET status=$2,result=$3,error=$4 WHERE id=$1 RETURNING *',[id,status,json(result),error])).rows);
    if (!row) throw new Error('Proposal not found'); return row;
  }
  async recordRefund(refund:Omit<Refund,'id'|'createdAt'|'simulated'>) {
    try { return await this.transaction(async client=> {
      const row=map<Refund>((await client.query('INSERT INTO support_refunds(id,payment_id,proposal_id,amount_cents,provider_ref) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),refund.paymentId,refund.proposalId,refund.amountCents,refund.providerRef])).rows[0]);
      await client.query("UPDATE support_payments SET status='refunded' WHERE id=$1",[refund.paymentId]); return row;
    }); } catch(error) { if (error && typeof error==='object' && 'code' in error && error.code==='23505') throw new DuplicateRefund('Payment already refunded'); throw error; }
  }
  async refunds(customerId?:string) { return (await this.pool.query('SELECT r.* FROM support_refunds r JOIN support_payments p ON p.id=r.payment_id WHERE ($1::uuid IS NULL OR p.customer_id=$1) ORDER BY r.created_at,r.id',[customerId??null])).rows.map(r=>map<Refund>(r)); }
  async audit(caseId:string,type:string,actor:string,data:Record<string,unknown>={}) {
    return map<AuditEvent>((await this.pool.query('INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),caseId,type,actor,json(data)])).rows[0]);
  }
  async auditEvents(caseId:string) { return (await this.pool.query('SELECT * FROM support_audit_events WHERE case_id=$1 ORDER BY created_at,id',[caseId])).rows.map(r=>map<AuditEvent>(r)); }
  async recordRun(run:Omit<AgentRun,'id'|'createdAt'>) { return map<AgentRun>((await this.pool.query('INSERT INTO support_agent_runs(id,case_id,provider,model,status,steps,tool_calls,latency_ms,error,turn_job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[randomUUID(),run.caseId,run.provider,run.model,run.status,run.steps,json(run.toolCalls),run.latencyMs,run.error,run.turnJobId??null])).rows[0]); }
  async runs(caseId?:string) { return (await this.pool.query('SELECT * FROM support_agent_runs WHERE ($1::uuid IS NULL OR case_id=$1) ORDER BY created_at,id',[caseId??null])).rows.map(r=>map<AgentRun>(r)); }
  async metrics():Promise<Metrics> {
    const [cases,proposals,refunds,runs]=await Promise.all([
      this.pool.query('SELECT status,priority,count(*)::int AS n FROM support_cases GROUP BY status,priority'),
      this.pool.query('SELECT status,count(*)::int AS n FROM support_proposals GROUP BY status'),
      this.pool.query('SELECT COALESCE(sum(amount_cents),0)::bigint AS n FROM support_refunds'),
      this.pool.query("SELECT count(*)::int AS n,count(*) FILTER(WHERE status='fallback')::int AS fallback,round(avg(latency_ms) FILTER(WHERE status<>'failed'))::int AS latency FROM support_agent_runs"),
    ]);
    const result:Metrics={cases:0,byStatus:{open:0,awaiting_approval:0,escalated:0,resolved:0},byPriority:{P1:0,P2:0,P3:0},proposals:{pending:0,approved:0,executing:0,executed:0,rejected:0,failed:0,denied:0,unknown:0,expired:0,invalidated:0},refundsIssuedCents:Number(refunds.rows[0].n),agentRuns:runs.rows[0].n,fallbackRuns:runs.rows[0].fallback,avgAgentLatencyMs:runs.rows[0].latency};
    for (const row of cases.rows) { result.cases+=row.n; result.byStatus[row.status as keyof Metrics['byStatus']]+=row.n; result.byPriority[row.priority as keyof Metrics['byPriority']]+=row.n; }
    for (const row of proposals.rows) result.proposals[row.status as keyof Metrics['proposals']]=row.n;
    return result;
  }
  async knowledge(businessId:string) { return (await this.pool.query('SELECT * FROM support_knowledge WHERE business_id=$1 ORDER BY updated_at DESC,id',[businessId])).rows.map(r=>map<KnowledgeSource>(r)); }
  async saveKnowledge(source:KnowledgeSource,expectedVersion?:number) {
    if (expectedVersion===undefined) return map<KnowledgeSource>((await this.pool.query("INSERT INTO support_knowledge(id,business_id,title,category,content,version,status,updated_at,audience,plans,source_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'customer'),COALESCE($10::jsonb,'[]'::jsonb),$11) RETURNING *",[source.id,source.businessId,source.title,source.category,source.content,source.version,source.status,source.updatedAt,source.audience??null,source.plans?JSON.stringify(source.plans):null,source.sourceUrl??null])).rows[0]);
    const row=first<KnowledgeSource>((await this.pool.query('UPDATE support_knowledge SET title=$3,category=$4,content=$5,version=$6,status=$7,updated_at=$8,audience=COALESCE($10,audience),plans=COALESCE($11::jsonb,plans),source_url=CASE WHEN $12::boolean THEN $13 ELSE source_url END WHERE id=$1 AND business_id=$2 AND version=$9 RETURNING *',[source.id,source.businessId,source.title,source.category,source.content,source.version,source.status,source.updatedAt,expectedVersion,source.audience??null,source.plans?JSON.stringify(source.plans):null,source.sourceUrl!==undefined,source.sourceUrl??null])).rows);
    if (!row) throw new VersionConflict('Document version changed'); return row;
  }
  async knowledgeVersions(businessId:string,id:string) { return (await this.pool.query('SELECT knowledge_id AS id,business_id,title,category,content,version,status,updated_at,audience,plans,source_url FROM support_knowledge_versions WHERE business_id=$1 AND knowledge_id=$2 ORDER BY version DESC',[businessId,id])).rows.map(r=>map<KnowledgeSource>(r)); }
  async skills(businessId:string) { return (await this.pool.query('SELECT * FROM support_skills WHERE business_id=$1 ORDER BY name,id',[businessId])).rows.map(r=>map<SupportSkill>(r)); }
  async saveSkill(skill:SupportSkill) { return map<SupportSkill>((await this.pool.query('INSERT INTO support_skills(id,business_id,name,content,revision,enabled,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET content=excluded.content,revision=excluded.revision,enabled=excluded.enabled,updated_at=excluded.updated_at RETURNING *',[skill.id,skill.businessId,skill.name,skill.content,skill.revision,skill.enabled,skill.updatedAt])).rows[0]); }
  async settings(businessId:string):Promise<SupportSettings> {
    const row=first<StoredSettings>((await this.pool.query('SELECT * FROM support_settings WHERE business_id=$1',[businessId])).rows); if(row) return { ...row, classification: visibleClassification(row.classification) };
    const business=await this.business(businessId); if(!business) throw new Error('Business not found');
    return {businessId,version:1,language:'uk',tone:'empathetic',requireApproval:true,...business.policy};
  }
  async classificationState(businessId:string) {
    const result = await this.pool.query('SELECT classification FROM support_settings WHERE business_id=$1', [businessId]);
    return classificationState(result.rows[0]?.classification);
  }
  async saveSettings(settings:SupportSettings,expectedVersion:number) {
    return this.transaction(async client=> {
      // Business row is the serialization point, including the first settings write.
      await client.query('SELECT id FROM support_businesses WHERE id=$1 FOR UPDATE',[settings.businessId]);
      const old=first<StoredSettings>((await client.query('SELECT * FROM support_settings WHERE business_id=$1',[settings.businessId])).rows);
      if ((old?.version??1)!==expectedVersion) throw new VersionConflict('Settings version changed');
      if (!canReplaceClassification(old?.classification, settings.classification)) throw new VersionConflict('Classification changes require a newer revision');
      const classification = storedClassification(old?.classification, settings.classification);
      settings = { ...settings, classification: visibleClassification(classification) };
      await client.query('INSERT INTO support_settings(business_id,version,language,tone,require_approval,refund_limit_cents,duplicate_window_minutes,enabled_tools,classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(business_id) DO UPDATE SET version=excluded.version,language=excluded.language,tone=excluded.tone,require_approval=excluded.require_approval,refund_limit_cents=excluded.refund_limit_cents,duplicate_window_minutes=excluded.duplicate_window_minutes,enabled_tools=excluded.enabled_tools,classification=excluded.classification',[settings.businessId,settings.version,settings.language,settings.tone,true,settings.refundLimitCents,settings.duplicateWindowMinutes,json(settings.enabledTools),json(classification)]);
      await client.query('UPDATE support_businesses SET policy=$2 WHERE id=$1',[settings.businessId,json({refundLimitCents:settings.refundLimitCents,duplicateWindowMinutes:settings.duplicateWindowMinutes,enabledTools:settings.enabledTools})]); return settings;
    });
  }
}
