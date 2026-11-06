import { guardRulesSchema } from '../modules/support/guards.js';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { classificationConfigSchema } from '../modules/agent/classification.js';
import { safeKey, validateInputSchema, type InputSchema } from './schema.js';
import { manifestSchema } from './manifest.js';
import { integrationPolicySchema } from './permissions.js';
import { qdrantKnowledgeSchema } from '../modules/knowledge/qdrant.js';

const id = z.uuid();
const key = z.string().refine(safeKey, 'Expected a safe identifier');
const policy = z.strictObject({
  guards: guardRulesSchema.optional(), guardRevision: z.number().int().nonnegative().optional(),
  refundLimitCents: z.number().int().min(1).max(100_000_000),
  duplicateWindowMinutes: z.number().int().min(1).max(1440),
  enabledTools: z.array(z.enum(['lookup_payments', 'refund_payment', 'escalate_to_human'])).max(3),
});
const timestamp = z.iso.datetime().default('2026-01-01T00:00:00.000Z');
const toolSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  description: z.string().min(1).max(500),
  inputSchema: z.custom<InputSchema>(value => {
    try { validateInputSchema(value); return value.type === 'object'; } catch { return false; }
  }, 'Expected a bounded object JSON Schema'),
  scopeBindings: z.strictObject({ businessId: key, customerId: key }),
  outputFields: z.array(key).min(1).max(30),
  access: z.literal('read'),
}).superRefine((tool, ctx) => {
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object') return;
  const fields = Object.values(tool.scopeBindings);
  if (new Set(fields).size !== 2 || fields.some(field => Object.hasOwn(tool.inputSchema.properties ?? {}, field))) ctx.addIssue({ code: 'custom', message: 'Scope fields must be distinct and excluded from model inputSchema' });
});
/** MCP endpoints: HTTPS without credentials/query/fragment; plain HTTP only on explicit loopback for tests. */
const validMcpUrl = (raw: string, allowInsecureLoopback: boolean, allowInternalService = false) => {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  // A container-network service name (one DNS label, explicit port). Startup still requires the exact origin
  // in the deployment-owned MCP_INTERNAL_HTTP_ORIGINS; a public host can never take this path.
  const internal = allowInternalService && url.protocol === 'http:' && INTERNAL_SERVICE_ORIGIN.test(url.origin);
  return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (url.protocol === 'http:' && local && allowInsecureLoopback) || internal);
};
export const INTERNAL_SERVICE_ORIGIN = /^http:\/\/(?!localhost:)[a-z][a-z0-9-]{0,62}:[1-9]\d{0,4}$/;
const integrationSchema = z.strictObject({
  id: key, businessId: id, url: z.url().max(1000),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(),
  allowInsecureLoopback: z.boolean().default(false),
  timeoutMs: z.number().int().min(50).max(30_000).default(5000),
  maxOutputBytes: z.number().int().min(128).max(32_768).default(8192),
  tools: z.array(toolSchema).min(1).max(20),
}).superRefine((integration, ctx) => {
  let url: URL;
  try { url = new URL(integration.url); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid MCP URL' }); return; }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && integration.allowInsecureLoopback))) ctx.addIssue({ code: 'custom', message: 'MCP requires HTTPS without URL credentials/query/fragment; explicit loopback HTTP is available for tests' });
  if (new Set(integration.tools.map(tool => tool.name)).size !== integration.tools.length) ctx.addIssue({ code: 'custom', message: 'Duplicate configured tool name' });
});

// Reviewed OpenAPI catalog served by the Python sidecar (docs/integrations-manifest.md). The manifest and the
// policy are embedded so the single read-only config mount carries them; credentials stay in the environment.
const catalogSchema = z.strictObject({
  businessId: id,
  connectionRevision: z.string().regex(/^[1-9]\d{0,14}$/).default('1'),
  upstreamTargetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  upstreamBusinessId: z.string().min(1).max(200).optional(),
  customerIdMap: z.record(id, z.string().min(1).max(200)).optional(),
  url: z.url().max(1000),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  allowInsecureLoopback: z.boolean().default(false),
  timeoutMs: z.number().int().min(50).max(30_000).default(5000),
  maxOutputBytes: z.number().int().min(128).max(32_768).default(8192),
  manifest: manifestSchema,
  policy: integrationPolicySchema,
}).superRefine((catalog, ctx) => {
  if (!validMcpUrl(catalog.url, catalog.allowInsecureLoopback, true)) ctx.addIssue({ code: 'custom', message: 'Catalog sidecar URL requires HTTPS, or HTTP to an internal service origin (http://<service>:<port>), without URL credentials/query/fragment; explicit loopback HTTP is available for tests' });
  // A mismatch would make every call fail closed at runtime; refuse it at startup where an operator sees it.
  if (catalog.policy.businessId !== catalog.businessId) ctx.addIssue({ code: 'custom', message: 'Catalog policy belongs to another business' });
  if (catalog.policy.integrationId !== catalog.manifest.integrationId) ctx.addIssue({ code: 'custom', message: 'Catalog policy is for another integration' });
  if (catalog.policy.manifestHash !== catalog.manifest.manifestHash) ctx.addIssue({ code: 'custom', message: 'Catalog policy was reviewed against another manifest' });
});

export const supportConfigSchema = z.strictObject({
  version: z.literal(1).default(1),
  businesses: z.array(z.strictObject({ id, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), name: z.string().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/), policy })).max(100).default([]),
  knowledge: z.array(z.strictObject({ id, businessId: id, title: z.string().min(1).max(200), category: z.string().max(100).default('general'), content: z.string().min(1).max(50_000), version: z.number().int().positive(), status: z.enum(['draft', 'published', 'revoked']), updatedAt: timestamp, audience: z.enum(['customer', 'internal']).optional(), plans: z.array(z.string().min(1).max(80)).max(20).optional(), sourceUrl: z.url().max(2000).nullable().optional() })).max(500).default([]),
  guardPolicies: z.array(z.strictObject({businessId:id,revision:z.number().int().positive(),guards:guardRulesSchema})).max(100).default([]),
  skills: z.array(z.strictObject({ id, businessId: id, name: z.string().min(1).max(200), content: z.string().min(1).max(20_000), revision: z.number().int().positive(), enabled: z.boolean(), updatedAt: timestamp })).max(200).default([]),
  classifications: z.array(classificationConfigSchema.safeExtend({ businessId: id })).max(100).default([]),
  integrations: z.array(integrationSchema).max(100).default([]),
  externalKnowledge: z.array(qdrantKnowledgeSchema).max(100).default([]),
  catalogs: z.array(catalogSchema).max(20).default([]),
}).superRefine((config, ctx) => {
  for (const field of ['businesses', 'knowledge', 'skills', 'integrations'] as const) {
    if (new Set(config[field].map(row => row.id)).size !== config[field].length) ctx.addIssue({ code: 'custom', message: `Duplicate ${field} id` });
  }
  if (new Set(config.businesses.map(row => row.slug)).size !== config.businesses.length) ctx.addIssue({ code: 'custom', message: 'Duplicate business slug' });
  if(new Set(config.guardPolicies.map(row=>row.businessId)).size!==config.guardPolicies.length) ctx.addIssue({code:'custom',message:'Duplicate guard policy business'});
  if (new Set(config.classifications.map(row => row.businessId)).size !== config.classifications.length) ctx.addIssue({ code: 'custom', message: 'Duplicate classification business' });
  if (new Set(config.externalKnowledge.map(row => row.id)).size !== config.externalKnowledge.length) ctx.addIssue({ code: 'custom', message: 'Duplicate external knowledge connector id' });
  if (new Set(config.externalKnowledge.map(row => row.businessId)).size !== config.externalKnowledge.length) ctx.addIssue({ code: 'custom', message: 'Only one external knowledge connector per business is supported' });
  // Proposals and routing identify an integration by business + id, across both integration kinds.
  const owned = [...config.integrations.map(row => `${row.businessId}/${row.id}`), ...config.catalogs.map(row => `${row.businessId}/${row.manifest.integrationId}`)];
  if (new Set(owned).size !== owned.length) ctx.addIssue({ code: 'custom', message: 'Duplicate integration id within a business' });
});
export type SupportConfig = z.infer<typeof supportConfigSchema>;
export type McpIntegrationConfig = SupportConfig['integrations'][number];

/** This file is operator-controlled. No API accepts paths, URLs, credentials or executable code. */
export async function loadSupportConfig(file?: string): Promise<SupportConfig> {
  if (!file) return supportConfigSchema.parse({});
  if ((await stat(file)).size > 2_000_000) throw new Error('Support config exceeds 2 MB');
  const content = await readFile(file, 'utf8');
  if (Buffer.byteLength(content) > 2_000_000) throw new Error('Support config exceeds 2 MB');
  return supportConfigSchema.parse(JSON.parse(content) as unknown);
}
