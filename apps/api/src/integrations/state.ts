import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Manifest } from './manifest.js';
import { fingerprint, integrationPolicySchema, resolvePermission, type IntegrationPolicy } from './permissions.js';
import type { Proposal, SupportCase } from '../modules/support/contracts.js';

export class IntegrationConflict extends Error {}
export interface IntegrationState {
  businessId: string; integrationId: string; enabled: boolean; draining: boolean;
  activeManifestHash: string | null; loadedManifestHash: string; connectionRevision: string;
  connectionHash: string; version: number; policy: IntegrationPolicy; updatedAt: string;
  bootstrapPolicies: Record<string, string>;
}
export interface IntegrationSeed {
  businessId: string; manifest: Manifest; policy: IntegrationPolicy;
  connectionRevision: string; connectionHash: string;
}
export interface IntegrationStore {
  bootstrap(seed: IntegrationSeed): Promise<void>;
  list(businessId: string): Promise<IntegrationState[]>;
  get(businessId: string, integrationId: string): Promise<IntegrationState | null>;
  manifest(businessId: string, integrationId: string, hash: string): Promise<Manifest | null>;
  change(businessId: string, integrationId: string, version: number, actor: string, event: string,
    mutate: (state: IntegrationState) => IntegrationState): Promise<IntegrationState>;
  events(businessId: string, integrationId: string): Promise<IntegrationAudit[]>;
}
export interface IntegrationAudit { id: string; businessId: string; integrationId: string; actor: string; type: string; version: number; createdAt: string; data: Record<string,unknown> }
const copy = <T>(value: T): T => structuredClone(value);
const key = (businessId: string, integrationId: string) => `${businessId}/${integrationId}`;
const auditData = (state:IntegrationState) => ({ manifestHash:state.loadedManifestHash,activeManifestHash:state.activeManifestHash,connectionRevision:state.connectionRevision,policyRevision:state.policy.policyRevision,enabled:state.enabled,draining:state.draining,operations:state.policy.operations });

function bootstrapState(old: IntegrationState | null, seed: IntegrationSeed): IntegrationState {
  const seedHash = fingerprint(seed.policy);
  if (old) {
    const previous = old.bootstrapPolicies[String(seed.policy.policyRevision)];
    if (previous && previous !== seedHash) throw new IntegrationConflict('Same bootstrap policy revision has different content');
    if (seed.connectionRevision === old.connectionRevision && seed.connectionHash !== old.connectionHash) throw new IntegrationConflict('Connection mapping changes require a newer connectionRevision');
    if (BigInt(seed.connectionRevision) < BigInt(old.connectionRevision)) return old;
    if (seed.connectionRevision !== old.connectionRevision && old.enabled) throw new IntegrationConflict('Disable the integration before changing its connection');
    const changed = seed.manifest.manifestHash !== old.loadedManifestHash || seed.connectionRevision !== old.connectionRevision;
    return { ...old, ...(changed ? { loadedManifestHash: seed.manifest.manifestHash, connectionRevision: seed.connectionRevision, connectionHash: seed.connectionHash,
      enabled: false, draining: true, version: old.version + 1, updatedAt: new Date().toISOString() } : {}),
      bootstrapPolicies: { ...old.bootstrapPolicies, [seed.policy.policyRevision]: seedHash } };
  }
  return {
    businessId: seed.businessId, integrationId: seed.manifest.integrationId, enabled: false, draining: false,
    activeManifestHash: null, loadedManifestHash: seed.manifest.manifestHash,
    connectionRevision: seed.connectionRevision, connectionHash: seed.connectionHash, version: 1, updatedAt: new Date().toISOString(),
    bootstrapPolicies: { [seed.policy.policyRevision]: seedHash },
    policy: { ...copy(seed.policy), enabled: false, defaultMode: 'deny', operations: seed.manifest.operations.map(op => ({ operationKey: op.operationKey, enabled: false, reviewedOperationHash: null, mode: 'inherit' })) },
  };
}

/** The DB state is authoritative; process-local catalog copies may only narrow it. */
export function effectivePolicy(state: IntegrationState): IntegrationPolicy {
  return { ...state.policy, enabled: state.enabled === true && state.draining === false, manifestHash: state.activeManifestHash ?? '' };
}

/** Used under the same serialization point as policy edits, disable and execution claim. */
export function externalAdmissionReason(proposal: Proposal, supportCase: SupportCase, state: IntegrationState | null): string | null {
  if (proposal.tool !== 'external_action') return null;
  const args = proposal.args;
  if (typeof args.expiresAt !== 'string' || !Number.isFinite(Date.parse(args.expiresAt)) || Date.parse(args.expiresAt) <= Date.now()) return 'approval_expired';
  if (args.caseId !== supportCase.id || args.customerId !== supportCase.customerId || args.businessId !== supportCase.businessId || args.ownershipVersion !== supportCase.ownershipVersion || supportCase.ownership !== 'bot') return 'ownership_changed';
  // Static protocol-test helpers do not claim a DB-managed integration. Production factory always marks snapshots managed.
  if (args.managed === false && !state) return null;
  if (!state || state.enabled!==true || state.draining!==false) return 'integration_disabled';
  const parsedPolicy=integrationPolicySchema.safeParse(state.policy);if(!parsedPolicy.success) return 'policy_invalid';
  if (args.connectionRevision !== state.connectionRevision || args.manifestHash !== state.activeManifestHash || args.policyRevision !== parsedPolicy.data.policyRevision) return 'stale_snapshot';
  const rule = parsedPolicy.data.operations.find(op => op.operationKey === args.operationKey);
  if (!rule?.enabled || rule.reviewedOperationHash !== args.operationHash) return 'operation_unreviewed';
  // The catalog operation is checked again by the dispatcher; claim checks its immutable snapshot too.
  const decision = resolvePermission({ businessId: supportCase.businessId, integrationId: String(args.integrationId), manifestHash: String(args.manifestHash),
    operation: { operationKey: String(args.operationKey), operationHash: String(args.operationHash), effect: args.effect as 'read' | 'write', tags: Array.isArray(args.tags) ? args.tags as string[] : [] } }, effectivePolicy(state));
  if (decision.mode === 'deny' || (proposal.policy.requiresApproval === false && decision.mode !== 'auto')) return decision.reasonCode;
  return null;
}

export class MemoryIntegrationStore implements IntegrationStore {
  private rows = new Map<string, IntegrationState>();
  private catalogs = new Map<string, Manifest>();
  private auditRows: IntegrationAudit[] = [];
  constructor(private readonly invalidate: (businessId: string, integrationId: string, reason: string) => void = () => undefined,private readonly inFlight:(businessId:string,integrationId:string)=>boolean=()=>false) {}
  clear() { this.rows.clear(); this.catalogs.clear(); this.auditRows = []; }
  peek(businessId: string, integrationId: string) { return this.rows.get(key(businessId, integrationId)) ?? null; }
  async bootstrap(seed: IntegrationSeed) {
    const id = key(seed.businessId, seed.manifest.integrationId);
    const old = this.rows.get(id) ?? null;
    const next = bootstrapState(old, seed);
    this.catalogs.set(`${id}/${seed.manifest.manifestHash}`, copy(seed.manifest));
    this.rows.set(id, copy(next));
    if (!old || old.version !== next.version) {
      this.auditRows.push({ id: randomUUID(), businessId: seed.businessId, integrationId: seed.manifest.integrationId, actor: 'deployment', type: 'integration.imported', version: next.version, createdAt: next.updatedAt,data:auditData(next) });
      if (old) this.invalidate(seed.businessId, seed.manifest.integrationId, 'catalog_changed');
    }
  }
  async list(businessId: string) { return copy([...this.rows.values()].filter(row => row.businessId === businessId)); }
  async get(businessId: string, integrationId: string) { return copy(this.peek(businessId, integrationId)); }
  async manifest(businessId: string, integrationId: string, hash: string) { return copy(this.catalogs.get(`${key(businessId, integrationId)}/${hash}`) ?? null); }
  async change(businessId: string, integrationId: string, version: number, actor: string, event: string, mutate: (state: IntegrationState) => IntegrationState) {
    const id = key(businessId, integrationId); const old = this.rows.get(id);
    if (!old || old.version !== version) throw new IntegrationConflict('Integration version changed');
    if(event==='integration.activated'&&this.inFlight(businessId,integrationId)) throw new IntegrationConflict('Resolve in-flight or unknown executions before activation');
    const next = { ...mutate(copy(old)), version: old.version + 1, updatedAt: new Date().toISOString() };
    this.rows.set(id, copy(next)); this.invalidate(businessId, integrationId, event);
    this.auditRows.push({ id: randomUUID(), businessId, integrationId, actor, type: event, version: next.version, createdAt: next.updatedAt,data:auditData(next) });
    return copy(next);
  }
  async events(businessId: string, integrationId: string) { return copy(this.auditRows.filter(row => row.businessId === businessId && row.integrationId === integrationId)); }
}

export const lockIntegration = (client: Pick<pg.PoolClient, 'query'>, businessId: string, integrationId: string) =>
  client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`integration:${key(businessId, integrationId)}`]);

export async function invalidateExternalProposals(client: Pick<pg.PoolClient, 'query'>, businessId: string, integrationId: string, reason: string) {
  const cases=await client.query("SELECT DISTINCT c.id FROM support_cases c JOIN support_proposals p ON p.case_id=c.id WHERE c.business_id=$1 AND p.tool='external_action' AND p.args->>'integrationId'=$2 AND p.status IN ('pending','approved') ORDER BY c.id",[businessId,integrationId]);
  for(const supportCase of cases.rows) {
    await client.query('SELECT id FROM support_cases WHERE id=$1 FOR UPDATE',[supportCase.id]);
    const rows=await client.query("UPDATE support_proposals SET status='invalidated',error=$3 WHERE case_id=$1 AND tool='external_action' AND args->>'integrationId'=$2 AND status IN ('pending','approved') RETURNING id,args",[supportCase.id,integrationId,reason]);
    if(!rows.rowCount) continue;
    for(const row of rows.rows) {
      await client.query("INSERT INTO support_messages(id,case_id,role,body) VALUES($1,$2,'assistant',$3)",[randomUUID(),supportCase.id,`Запит «${String(row.args.title)}» відкликано через зміну налаштувань інтеграції. Його не виконано; звернення передано спеціалісту.`]);
      await client.query("INSERT INTO support_audit_events(id,case_id,type,actor,data) VALUES($1,$2,'action.invalidated','system:integration',$3)",[randomUUID(),supportCase.id,JSON.stringify({proposalId:row.id,integrationId,reasonCode:reason})]);
    }
    await client.query("UPDATE support_cases SET ownership='staff',ownership_version=ownership_version+1,assigned_to='queue:tier-2',status='escalated',active_run_id=NULL,active_run_at=NULL,updated_at=now() WHERE id=$1",[supportCase.id]);
    await client.query("UPDATE support_proposals SET status=CASE WHEN tool='external_action' THEN 'invalidated' ELSE 'rejected' END,error='Conversation handed to staff' WHERE case_id=$1 AND status IN ('pending','approved')",[supportCase.id]);
    await client.query("UPDATE support_turn_jobs SET status='cancelled',worker_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE case_id=$1 AND status IN ('queued','running')",[supportCase.id]);
  }
}

export class PostgresIntegrationStore implements IntegrationStore {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async bootstrap(seed: IntegrationSeed) {
    await this.transaction(async client => {
      await lockIntegration(client, seed.businessId, seed.manifest.integrationId);
      const old = (await client.query('SELECT state FROM support_integrations WHERE business_id=$1 AND integration_id=$2', [seed.businessId, seed.manifest.integrationId])).rows[0]?.state as IntegrationState | undefined;
      const next = bootstrapState(old ?? null, seed);
      await client.query('INSERT INTO support_integration_manifests(business_id,integration_id,manifest_hash,manifest) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [seed.businessId, seed.manifest.integrationId, seed.manifest.manifestHash, JSON.stringify(seed.manifest)]);
      await client.query('INSERT INTO support_integrations(business_id,integration_id,state) VALUES($1,$2,$3) ON CONFLICT(business_id,integration_id) DO UPDATE SET state=excluded.state', [seed.businessId, seed.manifest.integrationId, JSON.stringify(next)]);
      if (!old || old.version !== next.version) {
        await this.record(client, next, 'deployment', 'integration.imported');
        if (old) await invalidateExternalProposals(client, seed.businessId, seed.manifest.integrationId, 'catalog_changed');
      }
    });
  }
  async list(businessId: string): Promise<IntegrationState[]> { return (await this.pool.query('SELECT state FROM support_integrations WHERE business_id=$1 ORDER BY integration_id', [businessId])).rows.map(row => row.state as IntegrationState); }
  async get(businessId: string, integrationId: string): Promise<IntegrationState | null> { return (await this.pool.query('SELECT state FROM support_integrations WHERE business_id=$1 AND integration_id=$2', [businessId, integrationId])).rows[0]?.state ?? null; }
  async manifest(businessId: string, integrationId: string, hash: string): Promise<Manifest | null> { return (await this.pool.query('SELECT manifest FROM support_integration_manifests WHERE business_id=$1 AND integration_id=$2 AND manifest_hash=$3', [businessId, integrationId, hash])).rows[0]?.manifest ?? null; }
  async change(businessId: string, integrationId: string, version: number, actor: string, event: string, mutate: (state: IntegrationState) => IntegrationState) {
    return this.transaction(async client => {
      await lockIntegration(client, businessId, integrationId);
      const old = (await client.query('SELECT state FROM support_integrations WHERE business_id=$1 AND integration_id=$2 FOR UPDATE', [businessId, integrationId])).rows[0]?.state as IntegrationState | undefined;
      if (!old || old.version !== version) throw new IntegrationConflict('Integration version changed');
      if(event==='integration.activated'&&(await client.query("SELECT 1 FROM support_external_executions WHERE business_id=$1 AND integration_id=$2 AND status IN ('admitted','dispatched','unknown') LIMIT 1",[businessId,integrationId])).rowCount) throw new IntegrationConflict('Resolve in-flight or unknown executions before activation');
      const next = { ...mutate(copy(old)), version: old.version + 1, updatedAt: new Date().toISOString() };
      await client.query('UPDATE support_integrations SET state=$3 WHERE business_id=$1 AND integration_id=$2', [businessId, integrationId, JSON.stringify(next)]);
      await invalidateExternalProposals(client, businessId, integrationId, event);
      await this.record(client, next, actor, event);
      return next;
    });
  }
  private async record(client: pg.PoolClient, state: IntegrationState, actor: string, type: string) {
    await client.query('INSERT INTO support_integration_audit(id,business_id,integration_id,actor,type,version,data) VALUES($1,$2,$3,$4,$5,$6,$7)', [randomUUID(), state.businessId, state.integrationId, actor, type, state.version,JSON.stringify(auditData(state))]);
  }
  async events(businessId: string, integrationId: string): Promise<IntegrationAudit[]> {
    return (await this.pool.query('SELECT id,business_id AS "businessId",integration_id AS "integrationId",actor,type,version,data,created_at AS "createdAt" FROM support_integration_audit WHERE business_id=$1 AND integration_id=$2 ORDER BY created_at,id', [businessId, integrationId])).rows.map(row => ({ ...row, createdAt: (row.createdAt as Date).toISOString() })) as IntegrationAudit[];
  }
}
