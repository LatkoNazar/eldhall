import { z } from 'zod';
import { literalValue } from './env.js';

const safeText = (maximum: number) => z.string().min(1).max(maximum).refine(literalValue);
const source = z.union([
  z.strictObject({ file: safeText(4096) }),
  z.strictObject({ env: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/) }),
]);
const model = safeText(200);
const localBaseUrl = safeText(1000).refine(value => {
  try { const url = new URL(value); return value === value.trim() && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
});
const provider = z.discriminatedUnion('id', [
  z.strictObject({ id: z.literal('rules') }),
  z.strictObject({ id: z.literal('google'), model, key: source }),
  z.strictObject({ id: z.literal('openai'), model, key: source }),
  z.strictObject({ id: z.literal('anthropic'), model, key: source }),
  z.strictObject({ id: z.literal('local'), model, baseUrl: localBaseUrl, key: source.optional() }),
]);
export const initRequestSchema = z.strictObject({
  initRequestFormat: z.literal(1),
  project: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63),
  mode: z.enum(['evaluation', 'production']),
  database: z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('bundled') }), z.strictObject({ mode: z.literal('external'), url: source })]),
  provider,
}).superRefine((request, context) => {
  if ((request.mode === 'evaluation') !== (request.provider.id === 'rules')) context.addIssue({ code: 'custom', message: 'Evaluation requires rules; production requires an explicit model provider' });
});
export type InitRequest = z.infer<typeof initRequestSchema>;

const version = z.string().max(128).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/);
export const preparedBySchema = z.strictObject({ version, packageVersion: version, sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).nullable() });
export type PreparedBy = z.infer<typeof preparedBySchema>;
const publicProvider = z.discriminatedUnion('id', [
  z.strictObject({ id: z.literal('rules'), keyConfigured: z.literal(false) }),
  ...(['google', 'openai', 'anthropic'] as const).map(id => z.strictObject({ id: z.literal(id), model, keyConfigured: z.literal(true) })),
  z.strictObject({ id: z.literal('local'), model, baseUrl: localBaseUrl, keyConfigured: z.boolean() }),
]);
export function plannedResources(installationId: string, project: string, database: 'bundled' | 'external') {
  const hex = installationId.replaceAll('-', '');
  const composeProject = `eldhall-${project.slice(0, 16).replace(/-$/, '')}-${hex}`;
  return { composeProject, postgresVolume: database === 'bundled' ? `${composeProject}_postgres_data` : null,
    redisVolume: `${composeProject}_redis_data`, runtimeVolume: `${composeProject}_runtime_data`,
    queue: { database: 2 as const, prefix: `eldhall_${hex}`, jobsQueue: 'jobs-transform-v1' as const } };
}
export const installationSchema = z.strictObject({
  installationFormat: z.literal(1), installationId: z.string().uuid().refine(value => value === value.toLowerCase()), projectName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63), state: z.literal('prepared'),
  releaseBinding: z.strictObject({ status: z.literal('unbound'), manifest: z.null() }),
  intent: z.strictObject({ project: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(63), mode: z.enum(['evaluation', 'production']), database: z.strictObject({ mode: z.enum(['bundled', 'external']) }), provider: publicProvider }),
  plannedResources: z.strictObject({ composeProject: z.string(), postgresVolume: z.string().nullable(), redisVolume: z.string(), runtimeVolume: z.string(), queue: z.strictObject({ database: z.literal(2), prefix: z.string(), jobsQueue: z.literal('jobs-transform-v1') }) }),
  files: z.strictObject({ environment: z.literal('support.env'), supportConfig: z.literal('support.json') }), preparedBy: preparedBySchema,
}).superRefine((record, context) => {
  const expected = plannedResources(record.installationId, record.intent.project, record.intent.database.mode);
  if (record.projectName !== expected.composeProject || JSON.stringify(record.plannedResources) !== JSON.stringify(expected)) context.addIssue({ code: 'custom', message: 'Prospective namespace differs from the installation identity' });
  if ((record.intent.mode === 'evaluation') !== (record.intent.provider.id === 'rules')) context.addIssue({ code: 'custom', message: 'Invalid mode/provider identity' });
});
export type Installation = z.infer<typeof installationSchema>;
