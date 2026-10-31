import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { classificationConfigSchema } from '../modules/agent/classification.js';
import { safeKey, validateInputSchema, type InputSchema } from './schema.js';

const id = z.string().uuid();
const key = z.string().refine(safeKey, 'Expected a safe identifier');
const policy = z.object({
  refundLimitCents: z.number().int().min(1).max(100_000_000),
  duplicateWindowMinutes: z.number().int().min(1).max(1440),
  enabledTools: z.array(z.enum(['lookup_payments', 'refund_payment', 'escalate_to_human'])).max(3),
}).strict();
const timestamp = z.string().datetime().default('2026-01-01T00:00:00.000Z');
const toolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/),
  description: z.string().min(1).max(500),
  inputSchema: z.custom<InputSchema>(value => {
    try { validateInputSchema(value); return value.type === 'object'; } catch { return false; }
  }, 'Expected a bounded object JSON Schema'),
  scopeBindings: z.object({ businessId: key, customerId: key }).strict(),
  outputFields: z.array(key).min(1).max(30),
  access: z.literal('read'),
}).strict().superRefine((tool, ctx) => {
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object') return;
  const fields = Object.values(tool.scopeBindings);
  if (new Set(fields).size !== 2 || fields.some(field => Object.hasOwn(tool.inputSchema.properties ?? {}, field))) ctx.addIssue({ code: 'custom', message: 'Scope fields must be distinct and excluded from model inputSchema' });
});
const integrationSchema = z.object({
  id: key, businessId: id, url: z.string().url().max(1000),
  credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).optional(),
  allowInsecureLoopback: z.boolean().default(false),
  timeoutMs: z.number().int().min(50).max(30_000).default(5000),
  maxOutputBytes: z.number().int().min(128).max(32_768).default(8192),
  tools: z.array(toolSchema).min(1).max(20),
}).strict().superRefine((integration, ctx) => {
  let url: URL;
  try { url = new URL(integration.url); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid MCP URL' }); return; }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && integration.allowInsecureLoopback))) ctx.addIssue({ code: 'custom', message: 'MCP requires HTTPS without URL credentials/query/fragment; explicit loopback HTTP is available for tests' });
  if (new Set(integration.tools.map(tool => tool.name)).size !== integration.tools.length) ctx.addIssue({ code: 'custom', message: 'Duplicate configured tool name' });
});

export const supportConfigSchema = z.object({
  version: z.literal(1).default(1),
  businesses: z.array(z.object({ id, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), name: z.string().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/), policy }).strict()).max(100).default([]),
  knowledge: z.array(z.object({ id, businessId: id, title: z.string().min(1).max(200), category: z.string().max(100).default('general'), content: z.string().min(1).max(50_000), version: z.number().int().positive(), status: z.enum(['draft', 'published', 'revoked']), updatedAt: timestamp }).strict()).max(500).default([]),
  skills: z.array(z.object({ id, businessId: id, name: z.string().min(1).max(200), content: z.string().min(1).max(20_000), revision: z.number().int().positive(), enabled: z.boolean(), updatedAt: timestamp }).strict()).max(200).default([]),
  classifications: z.array(classificationConfigSchema.safeExtend({ businessId: id })).max(100).default([]),
  integrations: z.array(integrationSchema).max(100).default([]),
}).strict().superRefine((config, ctx) => {
  for (const field of ['businesses', 'knowledge', 'skills', 'integrations'] as const) {
    if (new Set(config[field].map(row => row.id)).size !== config[field].length) ctx.addIssue({ code: 'custom', message: `Duplicate ${field} id` });
  }
  if (new Set(config.businesses.map(row => row.slug)).size !== config.businesses.length) ctx.addIssue({ code: 'custom', message: 'Duplicate business slug' });
  if (new Set(config.classifications.map(row => row.businessId)).size !== config.classifications.length) ctx.addIssue({ code: 'custom', message: 'Duplicate classification business' });
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
