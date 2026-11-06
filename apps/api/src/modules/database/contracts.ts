import { z } from 'zod';

export const DATABASE_LIMIT_BOUNDS = {
  maxQueriesPerTurn: { min: 1, max: 12 }, timeoutMs: { min: 100, max: 5000 },
  maxRows: { min: 1, max: 200 }, maxBytes: { min: 1024, max: 65536 },
} as const;
export const DEFAULT_DATABASE_LIMITS = { maxQueriesPerTurn: 8, timeoutMs: 2000, maxRows: 100, maxBytes: 32768 } as const;
export const databaseLimitsSchema = z.strictObject({
  maxQueriesPerTurn: z.number().int().min(1).max(12), timeoutMs: z.number().int().min(100).max(5000),
  maxRows: z.number().int().min(1).max(200), maxBytes: z.number().int().min(1024).max(65536),
});
export const databaseInvestigationPolicySchema = z.strictObject({ enabled: z.boolean(), limits: databaseLimitsSchema });
export type DatabaseInvestigationPolicy = z.infer<typeof databaseInvestigationPolicySchema>;
export type DatabaseLimits = DatabaseInvestigationPolicy['limits'];
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).refine(value => !value.startsWith('pg_') && !['information_schema', '__proto__', 'constructor', 'prototype'].includes(value));
const columns = z.strictObject({ kind: z.literal('columns'), customerColumn: identifier, businessColumn: identifier });
export const databaseInvestigationSourceSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), label: z.string().min(1).max(100), businessId: z.uuid(),
  schema: identifier.default('public'), credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  upstreamBusinessId: z.string().min(1).max(200).optional(), customerIdMap: z.record(z.uuid(), z.string().min(1).max(200)).optional(),
  ownership: z.strictObject({ customerColumn: identifier.default('customer_id'), businessColumn: identifier.default('business_id') }).default({ customerColumn: 'customer_id', businessColumn: 'business_id' }),
  relations: z.array(z.strictObject({ table: identifier, columns: z.array(identifier).min(1).max(40).optional(), ownership: z.union([columns,
    z.strictObject({ kind: z.literal('parent'), parentTable: identifier, foreignKey: identifier, parentKey: identifier }),
  ]) })).max(40).default([]),
}).superRefine((source, context) => {
  if (new Set(source.relations.map(row => row.table)).size !== source.relations.length) context.addIssue({ code: 'custom', message: 'Duplicate relation ownership definition' });
  if (source.ownership.customerColumn === source.ownership.businessColumn) context.addIssue({ code: 'custom', message: 'Ownership columns must differ' });
  for (const row of source.relations) {
    if (row.columns && new Set(row.columns).size !== row.columns.length) context.addIssue({ code: 'custom', message: 'Duplicate selected column' });
    if (row.ownership.kind === 'columns' && row.ownership.customerColumn === row.ownership.businessColumn) context.addIssue({ code: 'custom', message: 'Ownership columns must differ' });
    const ownership = row.ownership;
    if (ownership.kind === 'parent' && (ownership.parentTable === row.table || source.relations.find(parent => parent.table === ownership.parentTable)?.ownership.kind === 'parent')) context.addIssue({ code: 'custom', message: 'Only a direct scoped parent is supported' });
  }
});
export type DatabaseInvestigationSourceConfig = z.infer<typeof databaseInvestigationSourceSchema>;
export interface DatabaseSourceDescriptor { id: string; label: string; status: 'configured' }
export interface DatabaseColumn { name: string; type: string; oid: number; description: string | null }
export interface DatabaseRelation { name: string; oid: number; columns: DatabaseColumn[]; ownershipTypes?: { business: string; customer: string }; ownership: { kind: 'columns'; customerColumn: string; businessColumn: string } | { kind: 'parent'; parentTable: string; foreignKey: string; parentKey: string } }
export interface DatabaseScope { businessId: string; customerId: string }
export type DatabaseAudit = { businessId: string; caseId?: string; sourceId: string; tool: string; queryId: string; queryHash?: string; rowCount?: number; truncated?: boolean; elapsedMs: number; outcome: 'succeeded' | 'denied' | 'failed'; reasonCode?: string; limits: DatabaseLimits };
export class DatabaseInvestigationError extends Error {
  constructor(readonly code: 'disabled' | 'invalid_query' | 'scope_unavailable' | 'unavailable' | 'role_not_readonly' | 'limit_exceeded' | 'timeout' | 'cancelled' | 'stale_policy') { super('Database investigation refused: ' + code); this.name = 'DatabaseInvestigationError'; }
}
