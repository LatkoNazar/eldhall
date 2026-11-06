import { z } from 'zod';
import { parseInstallationJson } from '../installation/json.js';
import { schemaComponent, schemaHash, schemaObservationSchema, schemaSourceSchema, schemaSourcesSchema, schemaSourcePaths, schemaStateHash, schemaStateProfile, type SchemaComponent, type SchemaSources } from './schema-state-contracts.js';

const reference = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), component: schemaComponent,
  profile: z.enum(['starter-public', 'vector-unavailable', 'vector-available-uninstalled', 'vector-installed']), fingerprint: schemaHash,
  sources: z.array(schemaSourceSchema).min(schemaSourcePaths.starter.length).max(schemaSourcePaths.support.length),
  evidence: z.strictObject({ sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), runId: z.string().regex(/^[0-9]{1,30}$/), postgresVersionNum: z.number().int().min(170000).max(179999),
    fixtureImageInput: z.string().max(300).regex(/^docker\.io\/(?:library\/postgres|pgvector\/pgvector):[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64}$/) }),
}).superRefine((value, context) => {
  if (JSON.stringify(value.sources.map(file => file.path)) !== JSON.stringify(schemaSourcePaths[value.component])) context.addIssue({ code: 'custom', message: 'Reference lacks ordered migration and runner sources' });
  if ((value.component === 'starter') !== (value.profile === 'starter-public')) context.addIssue({ code: 'custom', message: 'Reference component profile differs' });
});
export const schemaReferenceRegistrySchema = z.strictObject({ registryFormat: z.literal(1), observerProfile: z.literal(schemaStateProfile), status: z.literal('reviewed'), entries: z.array(reference).max(100) }).superRefine((value, context) => {
  const ids = new Set<string>(), matches = new Set<string>();
  for (const entry of value.entries) {
    const key = schemaStateHash({ component: entry.component, profile: entry.profile, fingerprint: entry.fingerprint, sources: entry.sources });
    if (ids.has(entry.id) || matches.has(key)) context.addIssue({ code: 'custom', message: 'Reference registry is ambiguous' });
    ids.add(entry.id); matches.add(key);
  }
});
export type SchemaReferenceRegistry = z.infer<typeof schemaReferenceRegistrySchema>;
export type SchemaReference = SchemaReferenceRegistry['entries'][number];

/** Reuse the bounded-depth duplicate-safe JSON parser, never raw parser errors. */
export function parseSchemaReferenceRegistry(text: string): SchemaReferenceRegistry {
  try {
    if (Buffer.byteLength(text) > 200_000) throw new Error('Registry exceeds limit');
    return schemaReferenceRegistrySchema.parse(parseInstallationJson(text));
  } catch { throw new Error('Schema reference registry is invalid'); }
}

/** Explicit trusted local registry only; no default, live enrollment, SQL or epoch inference. */
export function matchSchemaReferences(rawObservation: unknown, rawRegistry: unknown, rawSources: unknown): Record<SchemaComponent, { status: 'matched' | 'denied'; referenceId: string | null; reason: string }> {
  const denied = (reason: string) => ({ starter: { status: 'denied' as const, referenceId: null, reason }, support: { status: 'denied' as const, referenceId: null, reason } });
  const observation = schemaObservationSchema.safeParse(rawObservation), registry = schemaReferenceRegistrySchema.safeParse(rawRegistry), sources = schemaSourcesSchema.safeParse(rawSources);
  if (!observation.success || !registry.success || !sources.success) return denied('invalid_observation_registry_or_sources');
  if (observation.data.status !== 'observed') return denied('schema_unobservable');
  return Object.fromEntries((['starter', 'support'] as const).map(component => {
    const state = observation.data.components[component];
    const found = state.presence === 'present' && registry.data.entries.find(entry => entry.component === component && entry.profile === state.profile && entry.fingerprint === state.fingerprint && schemaStateHash(entry.sources) === schemaStateHash(sources.data[component]));
    return [component, found ? { status: 'matched', referenceId: found.id, reason: 'exact_reviewed_reference' } : { status: 'denied', referenceId: null, reason: state.presence === 'absent' ? 'owned_component_absent' : state.presence === 'partial' ? 'owned_component_partial' : 'no_exact_reviewed_reference' }];
  })) as Record<SchemaComponent, { status: 'matched' | 'denied'; referenceId: string | null; reason: string }>;
}

/** Schema eligibility only. It cannot authorize DDL, claim storage, or fence later startup. */
export function planSchemaAdmission(observation: unknown, registry: unknown, sources: unknown, target: unknown) {
  const matches = matchSchemaReferences(observation, registry, sources);
  const requested = z.strictObject({ starter: z.string().max(100), support: z.string().max(100) }).safeParse(target);
  const accepted = requested.success && (['starter', 'support'] as const).every(component => matches[component].status === 'matched' && matches[component].referenceId === requested.data[component]);
  const parsed = schemaObservationSchema.safeParse(observation);
  const source = schemaSourcesSchema.safeParse(sources);
  return { planFormat: 1 as const, mode: 'diagnostic-only' as const, schemaEligible: { api: accepted, worker: accepted },
    migration: accepted ? 'not-required' as const : 'denied' as const, mutationAuthorized: false as const, matches,
    reason: accepted ? 'exact_current_pair' : requested.success ? 'unknown_partial_absent_or_target_mismatch' : 'invalid_target',
    expectedBefore: parsed.success && source.success ? schemaStateHash({ components: parsed.data.components, vector: parsed.data.vector, sources: source.data }) : null };
}

export function validateSchemaSources(input: unknown): SchemaSources { return schemaSourcesSchema.parse(input); }
