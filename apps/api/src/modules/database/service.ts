import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BusinessIntegrationContext, BusinessTool, ScopedBusinessTools } from '../../integrations/mcp.js';
import { activity } from '../support/activity.js';
import { assertReadOnlyRole, discoverDatabaseRelations } from './catalog.js';
import { compileDatabaseQuery, quoteIdentifier } from './compiler.js';
import { databaseInvestigationPolicySchema, databaseInvestigationSourceSchema, DatabaseInvestigationError, type DatabaseAudit, type DatabaseInvestigationPolicy, type DatabaseInvestigationSourceConfig, type DatabaseRelation } from './contracts.js';

export interface DatabaseServiceOptions {
  sources: { config: DatabaseInvestigationSourceConfig; pool: pg.Pool }[];
  getPolicy(businessId: string): Promise<DatabaseInvestigationPolicy & { version: number }>;
  onAudit?(event: DatabaseAudit): Promise<void>;
}
export interface DatabaseQueryResult {
  sourceId: string; queryId: string; asOf: string; scope: 'current_customer'; representation: 'typed_text';
  columns: { name: string; type: string }[]; rows: (string | null)[][]; rowCount: number; truncated: boolean;
}
export function createDatabaseInvestigationService(options: DatabaseServiceOptions) {
  const sources = options.sources.map(source => ({ ...source, config: databaseInvestigationSourceSchema.parse(source.config), active: 0 }));
  if (new Set(sources.map(source => source.config.businessId + '/' + source.config.id)).size !== sources.length) throw new Error('Duplicate database source');
  const getSources = (businessId: string) => sources.filter(row => row.config.businessId === businessId).map(row => ({ id: row.config.id, label: row.config.label, status: 'configured' as const }));
  const loadPolicy = async (businessId: string) => { try { const raw = await options.getPolicy(businessId); if (!Number.isSafeInteger(raw.version) || raw.version < 1) throw new Error(); return { version: raw.version, ...databaseInvestigationPolicySchema.parse({ enabled: raw.enabled, limits: raw.limits }) }; } catch { throw new DatabaseInvestigationError('disabled'); } };
  return {
    getSources,
    async close() { await Promise.all(sources.map(source => source.pool.end())); },
    forContext(context: BusinessIntegrationContext): ScopedBusinessTools {
      let queries = 0;
      const owned = sources.filter(source => source.config.businessId === context.businessId);
      const descriptions = { describe_database: 'Inspect approved database tables, columns and ownership relations for the current customer. No global schema or other customer data is available.', query_database: 'Read current-customer data with one SELECT. Supports JOIN, WHERE, GROUP BY, HAVING, ORDER BY and COUNT/SUM/AVG/MIN/MAX. Prefer GROUP BY existing columns (e.g. status, currency) with COUNT(*) or SUM(amount_cents), only when described. No CASE, FILTER, casts, CTEs, custom functions, writes or system schemas. Use safe integers; quote decimal comparisons (amount > \'10.25\'). Results are bounded typed text; check truncation. Reads never prove an action executed.' };
      const tool = (source: typeof sources[number], name: keyof typeof descriptions): BusinessTool => ({ integrationId: source.config.id, name, description: descriptions[name], inputSchema: name === 'describe_database' ? { type: 'object', properties: {}, additionalProperties: false } : { type: 'object', properties: { query: { type: 'string', maxLength: 8192, description: 'One supported PostgreSQL SELECT. Use only the approved logical schema; scope is applied by the server.' } }, required: ['query'], additionalProperties: false } });
      const run = async (source: typeof sources[number], name: string, query: string | undefined, signal?: AbortSignal) => {
        const started = Date.now(), queryId = randomUUID();
        let client: pg.PoolClient | undefined, discard = false, timedOut = false, active = false, inTransaction = false, queryHash: string | undefined;
        let prepared: string[] = [];
        const policy = await loadPolicy(context.businessId);
        const audit = async (event: Pick<DatabaseAudit, 'outcome' | 'reasonCode' | 'rowCount' | 'truncated'>) => {
          if (options.onAudit) await options.onAudit({ businessId: context.businessId, caseId: context.caseId, sourceId: source.config.id, tool: name, queryId, queryHash, elapsedMs: Date.now() - started, limits: policy.limits, ...event });
          await context.recordActivity?.(activity('guard', 'Customer-scoped database investigation', { tool: name, outcome: event.outcome, reason: event.reasonCode ?? null, input: null, result: { sourceId: source.config.id, queryId, queryHash: queryHash ?? null, elapsedMs: Date.now() - started, rowCount: event.rowCount ?? null, truncated: event.truncated ?? null, policyVersion: policy.version }, checks: [
            { name: 'database_read_only', passed: event.reasonCode !== 'role_not_readonly', detail: 'Read-only SQL profile' },
            { name: 'database_customer_scope', passed: !['scope_unavailable', 'invalid_query'].includes(event.reasonCode ?? ''), detail: 'Authenticated customer and workspace' },
            { name: 'database_resource_budget', passed: event.reasonCode !== 'limit_exceeded' && event.reasonCode !== 'timeout', detail: 'Server-enforced query budget' },
          ] }));
        };
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const abort = () => { discard = true; client?.release(true); client = undefined; };
        try {
          if (!policy.enabled) throw new DatabaseInvestigationError('disabled');
          if (source.config.customerIdMap && !Object.hasOwn(source.config.customerIdMap, context.customerId)) throw new DatabaseInvestigationError('scope_unavailable');
          if (++queries > policy.limits.maxQueriesPerTurn || source.active >= 2) throw new DatabaseInvestigationError('limit_exceeded');
          await context.assertActive(); signal?.throwIfAborted();
          if (source.active >= 2) throw new DatabaseInvestigationError('limit_exceeded');
          source.active++; active = true;
          signal?.addEventListener('abort', abort, { once: true });
          deadline = setTimeout(() => { timedOut = true; abort(); }, policy.limits.timeoutMs + 250);
          client = await source.pool.connect();
          if (discard || signal?.aborted) { client.release(true); client = undefined; throw new DatabaseInvestigationError(signal?.aborted ? 'cancelled' : 'timeout'); }
          await client.query('SET default_transaction_read_only=on');
          await client.query('SET search_path=pg_catalog');
          await client.query("SET application_name='eldhall-database-investigation'");
          await client.query(`SET statement_timeout=${policy.limits.timeoutMs}`);
          await client.query('SET lock_timeout=500');
          await assertReadOnlyRole(client);
          const before = await discoverDatabaseRelations(client, source.config);
          if (!before.length) throw new DatabaseInvestigationError('scope_unavailable');
          const scopedIdentity = { businessId: source.config.upstreamBusinessId ?? context.businessId, customerId: source.config.customerIdMap?.[context.customerId] ?? context.customerId };
          const compiled = query === undefined ? undefined : compileDatabaseQuery(query, source.config, before, scopedIdentity, policy.limits.maxRows);
          queryHash = compiled?.queryHash;
          const locked = compiled ? before.filter(row => compiled.relations.includes(row.name)) : before;
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
          inTransaction = true;
          await client.query('SET LOCAL search_path=pg_catalog');
          await client.query('SET LOCAL row_security=on');
          await client.query('SET LOCAL work_mem=\'1MB\'');
          for (const relation of [...locked].sort((a, b) => a.name.localeCompare(b.name))) {
            const statement = '__eldhall_lock_' + queryId.replaceAll('-', '') + '_' + prepared.length;
            // PREPARE acquires parser/rewrite relation locks but never plans or executes the SELECT.
            // This works with column grants; no table-level SELECT grant is required.
            await client.query(`PREPARE ${quoteIdentifier(statement)} AS SELECT ${relation.columns.map(column => quoteIdentifier(column.name)).join(',')} FROM ONLY ${quoteIdentifier(source.config.schema)}.${quoteIdentifier(relation.name)} LIMIT 0`);
            prepared.push(statement);
          }
          await assertReadOnlyRole(client);
          const after = await discoverDatabaseRelations(client, source.config);
          const stable = (relations: DatabaseRelation[]) => JSON.stringify(relations.filter(row => locked.some(old => old.name === row.name)));
          if (stable(before) !== stable(after)) throw new DatabaseInvestigationError('scope_unavailable');
          for (const statement of prepared) await client.query('DEALLOCATE ' + quoteIdentifier(statement));
          prepared = [];
          let result: DatabaseQueryResult | { sourceId: string; schema: string; scope: 'current_customer'; tables: unknown[] };
          if (!compiled) result = { sourceId: source.config.id, schema: source.config.schema, scope: 'current_customer', tables: after.map(({ name, columns, ownership }) => ({ name, ownership, columns: columns.map(({ name, type, description }) => ({ name, type, description })) })) };
          else {
            const output: DatabaseQueryResult = { sourceId: source.config.id, queryId, asOf: new Date().toISOString(), scope: 'current_customer', representation: 'typed_text', columns: compiled.columns.map(name => ({ name, type: 'unknown' })), rows: [], rowCount: 0, truncated: false }; result = output;
            await client.query('DECLARE "__eldhall_rows" NO SCROLL CURSOR FOR ' + compiled.text, compiled.values);
            for (let count = 0; count <= policy.limits.maxRows; count++) {
              const fetched = await client.query({ text: 'FETCH FORWARD 1 FROM "__eldhall_rows"', rowMode: 'array' });
              if (!fetched.rows.length) break;
              if (count === policy.limits.maxRows) { result.truncated = true; break; }
              const row: (string | null)[] = fetched.rows[0]!.map((cell: unknown, index: number) => {
                if (!Array.isArray(cell) || cell.length !== 2 || typeof cell[0] !== 'string' || cell[0].length > 100 || cell[1] !== null && typeof cell[1] !== 'string') throw new DatabaseInvestigationError('unavailable');
                output.columns[index]!.type = cell[0];
                if (typeof cell[1] === 'string' && cell[1].length > 2048) { output.truncated = true; return cell[1].slice(0, 2048); }
                return cell[1];
              });
              result.rows.push(row); result.rowCount = result.rows.length;
              if (Buffer.byteLength(JSON.stringify(result)) > policy.limits.maxBytes) { result.rows.pop(); result.rowCount = result.rows.length; result.truncated = true; break; }
            }
            await client.query('CLOSE "__eldhall_rows"');
          }
          if (Buffer.byteLength(JSON.stringify(result)) > policy.limits.maxBytes) throw new DatabaseInvestigationError('limit_exceeded');
          const next = await loadPolicy(context.businessId);
          if (JSON.stringify(next) !== JSON.stringify(policy)) throw new DatabaseInvestigationError('stale_policy');
          await context.assertActive(); signal?.throwIfAborted();
          await client.query('ROLLBACK');
          inTransaction = false;
          await audit({ outcome: 'succeeded', ...('rowCount' in result ? { rowCount: result.rowCount, truncated: result.truncated } : {}) });
          if ('rows' in result && result.rows.length && result.rows.some(row => row.some(value => value !== null && value !== ''))) context.rememberRead?.();
          return result;
        } catch (error) {
          if (prepared.length) discard = true;
          const code = signal?.aborted ? 'cancelled' : error instanceof DatabaseInvestigationError ? error.code : timedOut || error && typeof error === 'object' && Reflect.get(error, 'code') === '57014' ? 'timeout' : 'unavailable';
          await audit({ outcome: code === 'invalid_query' || code === 'disabled' || code === 'limit_exceeded' ? 'denied' : 'failed', reasonCode: code });
          throw new DatabaseInvestigationError(code);
        } finally {
          clearTimeout(deadline); signal?.removeEventListener('abort', abort);
          if (client) { if(inTransaction)try { await client.query('ROLLBACK'); } catch { discard = true; } client.release(discard); }
          if (active) source.active--;
        }
      };
      return {
        tools: [],
        async listTools() { await context.assertActive(); const policy = await loadPolicy(context.businessId); return policy.enabled ? owned.flatMap(source => [tool(source, 'describe_database'), tool(source, 'query_database')]) : []; },
        async callTool(integrationId, name, input, signal) {
          const source = owned.find(source => source.config.id === integrationId);
          if (!source || !['describe_database', 'query_database'].includes(name)) throw new DatabaseInvestigationError('disabled');
          if (name === 'describe_database' ? Object.keys(input).length !== 0 : Object.keys(input).length !== 1 || typeof input.query !== 'string') throw new DatabaseInvestigationError('invalid_query');
          return run(source, name, name === 'query_database' ? input.query as string : undefined, signal);
        },
      };
    },
  };
}
