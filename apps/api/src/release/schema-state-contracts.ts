import { createHash } from 'node:crypto';
import { z } from 'zod';

export const schemaStateProfile = 'eldhall-pg17-public-v2' as const;
export const starterRelations = ['jobs', 'alembic_version'] as const;
// These exact names are reviewed; the support_ prefix is NOT reserved.
export const supportRelations = ['support_businesses', 'support_customers', 'support_payments', 'support_cases', 'support_messages', 'support_proposals', 'support_payment_executions', 'support_refunds', 'support_audit_events', 'support_agent_runs', 'support_knowledge', 'support_skills', 'support_settings', 'support_turn_jobs', 'support_insight_runs', 'support_knowledge_versions', 'support_integrations', 'support_integration_manifests', 'support_integration_audit', 'support_external_executions', 'support_request_catalogs', 'support_request_checkpoints', 'support_request_events', 'support_integration_imports'] as const;
export const vectorRelation = 'support_knowledge_chunks';
export const schemaSourcePaths = {
  starter: ['apps/api/migrations/0001_jobs.sql', 'apps/api/src/core/migrations.ts'],
  support: ['apps/api/migrations/0002_support.sql', 'apps/api/migrations/0003_support_turns.sql', 'apps/api/migrations/0004_classification.sql', 'apps/api/migrations/0005_insights.sql', 'apps/api/migrations/0006_knowledge.sql', 'apps/api/migrations/0007_external_knowledge.sql', 'apps/api/migrations/0008_integrations.sql', 'apps/api/migrations/0009_customer_requests.sql', 'apps/api/migrations/0010_integration_imports.sql', 'apps/api/src/modules/support/migrations.ts'],
} as const;
export const schemaHash = z.string().regex(/^[a-f0-9]{64}$/);
export const schemaComponent = z.enum(['starter', 'support']);
export type SchemaComponent = z.infer<typeof schemaComponent>;
const profile = z.enum(['starter-public', 'vector-unavailable', 'vector-available-uninstalled', 'vector-installed', 'unsupported']);
const component = z.strictObject({ presence: z.enum(['absent', 'partial', 'present', 'unobservable']), profile, fingerprint: schemaHash.nullable() });
export const schemaObservationSchema = z.strictObject({
  observationFormat: z.literal(1), observerProfile: z.literal(schemaStateProfile), status: z.enum(['observed', 'unobservable']),
  postgresVersionNum: z.number().int().min(170000).max(179999).nullable(), databaseLocaleFingerprint: schemaHash.nullable(),
  components: z.strictObject({ starter: component, support: component }),
  starterMarker: z.enum(['absent', 'current', 'unknown', 'unreadable']),
  vector: z.strictObject({ available: z.boolean().nullable(), installed: z.boolean().nullable(), version: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).nullable(), namespace: z.enum(['public', 'other']).nullable() }),
  unmanagedPublicRelations: z.number().int().min(0).max(1000).nullable(),
  reason: z.enum(['invalid_connection', 'connection_or_catalog_unavailable', 'unsupported_postgres']).nullable(),
}).superRefine((value, context) => {
  if (value.status === 'unobservable' && (value.reason === null || Object.values(value.components).some(part => part.presence !== 'unobservable' || part.fingerprint !== null))) context.addIssue({ code: 'custom', message: 'Unobservable state cannot claim inspected components' });
  if (value.status === 'observed' && (value.reason !== null || value.postgresVersionNum === null || value.databaseLocaleFingerprint === null || value.unmanagedPublicRelations === null || Object.values(value.components).some(part => part.presence === 'unobservable' || (part.presence === 'absent') !== (part.fingerprint === null)))) context.addIssue({ code: 'custom', message: 'Observed state is incomplete' });
  if (value.status === 'observed') {
    const { starter, support } = value.components, vector = value.vector;
    if (starter.profile !== 'starter-public' || support.profile === 'starter-public' || vector.available === null || vector.installed === null) context.addIssue({ code: 'custom', message: 'Observed component profile is inconsistent' });
    if ((starter.presence === 'present' && value.starterMarker !== 'current') || (starter.presence === 'absent' && value.starterMarker !== 'absent')) context.addIssue({ code: 'custom', message: 'Observed marker state is inconsistent' });
    if (vector.installed ? vector.version === null || vector.namespace === null : vector.version !== null || vector.namespace !== null) context.addIssue({ code: 'custom', message: 'Observed extension state is inconsistent' });
    const expected = vector.installed ? vector.namespace === 'public' ? 'vector-installed' : 'unsupported' : vector.available ? 'vector-available-uninstalled' : 'vector-unavailable';
    if (support.profile !== expected || (support.presence === 'present' && expected === 'unsupported')) context.addIssue({ code: 'custom', message: 'Observed vector profile is inconsistent' });
  }
});
export type SchemaObservation = z.infer<typeof schemaObservationSchema>;
export const schemaSourceSchema = z.strictObject({ path: z.string().max(200), sha256: schemaHash });
export const schemaSourcesSchema = z.strictObject({ starter: z.array(schemaSourceSchema).length(schemaSourcePaths.starter.length), support: z.array(schemaSourceSchema).length(schemaSourcePaths.support.length) }).superRefine((value, context) => {
  for (const name of ['starter', 'support'] as const) if (JSON.stringify(value[name].map(file => file.path)) !== JSON.stringify(schemaSourcePaths[name])) context.addIssue({ code: 'custom', message: 'Ordered SQL and runner source identity is incomplete' });
});
export type SchemaSources = z.infer<typeof schemaSourcesSchema>;

/** Stable JSON, preserving array order and all literal contents; no SQL rewriting. */
export function schemaStateHash(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(Reflect.get(item, key))).join(',') + '}';
    throw new Error('Unsupported schema metadata');
  };
  const text = encode(value);
  if (Buffer.byteLength(text) > 2_000_000) throw new Error('Schema metadata exceeds its limit');
  return createHash('sha256').update(text).digest('hex');
}
