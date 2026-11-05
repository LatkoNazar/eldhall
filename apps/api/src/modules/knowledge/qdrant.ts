import { createHash } from 'node:crypto';
import { z } from 'zod';

const field = z.string().min(1).max(160).regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/).refine(value => !value.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)), 'Unsafe payload path');
const credential = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const match = z.strictObject({ field, value: z.union([z.string().min(1).max(200), z.number(), z.boolean()]) });
function validEndpoint(value: string, loopback: boolean): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || (loopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

/** Operator-controlled configuration only. These URLs and filters never come from customer/model input. */
export const qdrantKnowledgeSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), businessId: z.uuid(), type: z.literal('qdrant'),
  url: z.url().max(1000), collection: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.-]+$/), credentialEnv: credential.optional(),
  vectorName: z.string().min(1).max(100).optional(), allowInsecureLoopback: z.boolean().default(false),
  embedding: z.strictObject({ provider: z.enum(['openai', 'google', 'local']), model: z.string().min(1).max(200), dimensions: z.number().int().min(1).max(4096), credentialEnv: credential.optional(), baseUrl: z.url().max(1000).optional() }),
  fields: z.strictObject({ text: field, title: field.optional(), section: field.optional(), version: field.optional() }),
  access: z.strictObject({ tenant: match.optional(), singleTenant: z.boolean().default(false), published: match.optional(), customerVisible: match.optional(), trustedPublicCollection: z.boolean().default(false), planField: field.optional(), publicPlanValue: z.string().min(1).max(100).optional() }),
  limit: z.number().int().min(1).max(5).default(5), scoreThreshold: z.number().optional(), timeoutMs: z.number().int().min(100).max(30_000).default(5000),
}).superRefine((value, ctx) => {
  if (!validEndpoint(value.url, value.allowInsecureLoopback)) ctx.addIssue({ code: 'custom', message: 'Qdrant requires HTTPS without URL credentials/query/fragment, or explicitly allowed loopback HTTP' });
  if (!value.access.tenant && !value.access.singleTenant) ctx.addIssue({ code: 'custom', message: 'Set a tenant payload filter or explicitly declare a single-tenant collection' });
  if ((!value.access.published || !value.access.customerVisible) && !value.access.trustedPublicCollection) ctx.addIssue({ code: 'custom', message: 'Set publication and customer-visibility filters or explicitly trust the whole collection as published customer content' });
  if (value.access.publicPlanValue && !value.access.planField) ctx.addIssue({ code: 'custom', message: 'publicPlanValue requires planField' });
  if (value.embedding.provider === 'local') {
    if (!value.embedding.baseUrl || !validEndpoint(value.embedding.baseUrl, value.allowInsecureLoopback)) ctx.addIssue({ code: 'custom', message: 'Local embeddings require an explicit HTTPS or permitted loopback OpenAI-compatible baseUrl' });
  } else {
    if (value.embedding.baseUrl) ctx.addIssue({ code: 'custom', message: 'Hosted embedding providers use fixed endpoints' });
    if (!value.embedding.credentialEnv) ctx.addIssue({ code: 'custom', message: 'Hosted embedding providers require credentialEnv' });
  }
});
export type QdrantKnowledgeConfig = z.infer<typeof qdrantKnowledgeSchema>;
export interface ExternalKnowledgeRef { connectorId: string; pointId: string | number; contentHash: string }
export interface ExternalKnowledgeScope { businessId: string; plan: string }
export interface ExternalKnowledgeHit { id: string; title: string; content: string; version: number; section: string }
export interface ExternalKnowledge {
  hasBusiness(businessId: string): boolean;
  describe(businessId: string): { id: string; collection: string; embedder: string } | undefined;
  search(scope: ExternalKnowledgeScope, query: string, signal?: AbortSignal): Promise<{ hits: ExternalKnowledgeHit[]; refs: ExternalKnowledgeRef[] }>;
  validate(scope: ExternalKnowledgeScope, refs: ExternalKnowledgeRef[], signal?: AbortSignal): Promise<boolean>;
}
type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function at(payload: Json, path: string | undefined): unknown {
  if (!path) return undefined;
  let value: unknown = payload;
  for (const part of path.split('.')) {
    const record = object(value);
    if (!record || !Object.hasOwn(record, part)) return undefined;
    value = record[part];
  }
  return value;
}
const matches = (actual: unknown, expected: unknown): boolean => actual === expected || (Array.isArray(actual) && actual.includes(expected));
const pointId = (value: unknown): value is string | number => typeof value === 'string' ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A read-only client: collection inspection, query and point retrieval; no upsert/delete/reindex methods. */
class QdrantSource {
  private readonly token: string;
  private readonly embeddingToken: string;
  private readonly fingerprint: string;
  constructor(readonly config: QdrantKnowledgeConfig, env: NodeJS.ProcessEnv, private readonly fetcher: typeof fetch) {
    const secret = (name?: string) => {
      if (!name) return '';
      const value = env[name]?.trim();
      if (!value) throw new Error(`External knowledge credential ${name} is not configured`);
      return value;
    };
    this.token = secret(config.credentialEnv);
    this.embeddingToken = secret(config.embedding.credentialEnv);
    this.fingerprint = hash(config);
  }
  private async json(url: string, body: unknown | undefined, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    try {
      const response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Upstream request rejected'); }
      const declared = Number(response.headers.get('content-length'));
      if (declared > 512 * 1024) { await response.body?.cancel(); throw new Error('Response is too large'); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty upstream response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 512 * 1024) { await reader.cancel(); throw new Error('Response is too large'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      // Never return provider response bodies, credential-bearing requests or fetch causes.
      throw new Error('External knowledge request failed or exceeded its deadline');
    }
  }
  private endpoint(suffix = '') { return `${this.config.url.replace(/\/$/, '')}/collections/${encodeURIComponent(this.config.collection)}${suffix}`; }
  private headers(): Record<string, string> { return this.token ? { 'api-key': this.token } : {}; }
  private signal(signal?: AbortSignal): AbortSignal { const timeout = AbortSignal.timeout(this.config.timeoutMs); return signal ? AbortSignal.any([signal, timeout]) : timeout; }
  private conditions(scope: ExternalKnowledgeScope) {
    const conditions: { key: string; match: { value?: string | number | boolean; any?: string[] } }[] = [this.config.access.tenant, this.config.access.published, this.config.access.customerVisible].filter((item): item is NonNullable<typeof item> => Boolean(item)).map(item => ({ key: item.field, match: { value: item.value } }));
    if (this.config.access.planField) conditions.push({ key: this.config.access.planField, match: { any: [scope.plan, this.config.access.publicPlanValue].filter((v): v is string => v !== undefined) } });
    return conditions;
  }
  private fields(): string[] { return [...new Set([...Object.values(this.config.fields), this.config.access.tenant?.field, this.config.access.published?.field, this.config.access.customerVisible?.field, this.config.access.planField].filter((v): v is string => Boolean(v)))]; }
  private decode(raw: unknown, scope: ExternalKnowledgeScope): { hit: ExternalKnowledgeHit; ref: ExternalKnowledgeRef } | null {
    const point = object(raw), payload = object(point?.payload);
    if (!point || !pointId(point.id) || !payload) return null;
    for (const rule of [this.config.access.tenant, this.config.access.published, this.config.access.customerVisible]) if (rule && !matches(at(payload, rule.field), rule.value)) return null;
    if (this.config.access.planField) {
      const allowed = at(payload, this.config.access.planField);
      if (!matches(allowed, scope.plan) && !(this.config.access.publicPlanValue !== undefined && matches(allowed, this.config.access.publicPlanValue))) return null;
    }
    const text = at(payload, this.config.fields.text);
    if (typeof text !== 'string' || !text.trim() || text.length > 32_000) return null;
    const rawTitle = at(payload, this.config.fields.title), rawSection = at(payload, this.config.fields.section), revision = at(payload, this.config.fields.version);
    const title = typeof rawTitle === 'string' ? rawTitle.slice(0, 200) : 'External knowledge';
    const section = typeof rawSection === 'string' ? rawSection.slice(0, 200) : title;
    const contentHash = hash([this.fingerprint, point.id, this.fields().map(path => [path, at(payload, path)])]);
    return { hit: { id: `external:${this.config.id}:${point.id}`, title, content: text.slice(0, 8000), version: typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 ? revision : 1, section }, ref: { connectorId: this.config.id, pointId: point.id, contentHash } };
  }
  async search(scope: ExternalKnowledgeScope, query: string, outer?: AbortSignal) {
    const signal = this.signal(outer);
    // Inspect each time: collection aliases/configurations can change outside this application.
    const info = object(await this.json(this.endpoint(), undefined, this.headers(), signal));
    const params = object(object(object(info?.result)?.config)?.params), vectors = object(params?.vectors);
    const vector = this.config.vectorName ? object(vectors?.[this.config.vectorName]) : vectors;
    if (vector?.size !== this.config.embedding.dimensions || !['Cosine', 'Dot', 'Euclid', 'Manhattan'].includes(String(vector.distance))) throw new Error('Qdrant vector configuration does not match the configured embedding dimensions/name');
    const embedding = await this.embed(query, signal);
    const response = object(await this.json(this.endpoint('/points/query'), { query: embedding, ...(this.config.vectorName ? { using: this.config.vectorName } : {}), filter: { must: this.conditions(scope) }, limit: this.config.limit, with_payload: this.fields(), with_vector: false, ...(this.config.scoreThreshold === undefined ? {} : { score_threshold: this.config.scoreThreshold }) }, this.headers(), signal));
    const points = object(response?.result)?.points;
    if (!Array.isArray(points) || points.length > this.config.limit) throw new Error('Invalid Qdrant query response');
    return points.map(point => this.decode(point, scope)).filter((value): value is NonNullable<typeof value> => value !== null);
  }
  async validate(scope: ExternalKnowledgeScope, refs: ExternalKnowledgeRef[], outer?: AbortSignal): Promise<boolean> {
    if (refs.some(ref => !pointId(ref.pointId) || !/^[a-f0-9]{64}$/.test(ref.contentHash))) return false;
    const response = object(await this.json(this.endpoint('/points'), { ids: refs.map(ref => ref.pointId), with_payload: this.fields(), with_vector: false }, this.headers(), this.signal(outer)));
    if (!Array.isArray(response?.result) || response.result.length > refs.length) return false;
    const found = response.result.map(point => this.decode(point, scope));
    return refs.every(ref => found.some(item => item?.ref.pointId === ref.pointId && item.ref.contentHash === ref.contentHash));
  }
  private async embed(text: string, signal: AbortSignal): Promise<number[]> {
    const config = this.config.embedding;
    let vector: unknown;
    if (config.provider === 'google') {
      const response = object(await this.json(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:embedContent`, { model: `models/${config.model}`, content: { parts: [{ text }] }, taskType: 'RETRIEVAL_QUERY', outputDimensionality: config.dimensions }, { 'x-goog-api-key': this.embeddingToken }, signal));
      vector = object(response?.embedding)?.values;
    } else {
      const url = config.provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : `${config.baseUrl!.replace(/\/$/, '')}/embeddings`;
      const response = object(await this.json(url, { model: config.model, input: [text], dimensions: config.dimensions }, this.embeddingToken ? { Authorization: `Bearer ${this.embeddingToken}` } : {}, signal));
      vector = Array.isArray(response?.data) && response.data.length === 1 ? object(response.data[0])?.embedding : null;
    }
    if (!Array.isArray(vector) || vector.length !== config.dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) || !vector.some(value => value !== 0)) throw new Error('Embedding response does not match the configured dimensions');
    return vector as number[];
  }
}

export function createExternalKnowledge(configs: QdrantKnowledgeConfig[], env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ExternalKnowledge {
  const sources = configs.map(config => new QdrantSource(qdrantKnowledgeSchema.parse(config), env, fetcher));
  return {
    hasBusiness: businessId => sources.some(source => source.config.businessId === businessId),
    describe(businessId) {
      const source = sources.find(item => item.config.businessId === businessId);
      return source ? { id: source.config.id, collection: source.config.collection, embedder: `${source.config.embedding.provider}:${source.config.embedding.model}:${source.config.embedding.dimensions}` } : undefined;
    },
    async search(scope, query, signal) {
      if (!query.trim() || query.length > 2000) throw new Error('External knowledge query must contain 1–2000 characters');
      const results = await Promise.all(sources.filter(source => source.config.businessId === scope.businessId).map(source => source.search(scope, query, signal)));
      const items = results.flat().slice(0, 10);
      return { hits: items.map(item => item.hit), refs: items.map(item => item.ref) };
    },
    async validate(scope, refs, signal) {
      if (refs.length > 100) return false;
      try {
        const ids = [...new Set(refs.map(ref => ref.connectorId))];
        for (const id of ids) {
          const source = sources.find(item => item.config.id === id && item.config.businessId === scope.businessId);
          if (!source || !await source.validate(scope, refs.filter(ref => ref.connectorId === id), signal)) return false;
        }
        return true;
      } catch { return false; }
    },
  };
}
