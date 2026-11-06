import { guardDefinitions, guardRulesSchema } from './guards.js';
import { businessVisible, publicBusiness, scopedMetrics } from './workspace.js';
import { requestTransitionSchema } from './requests/contracts.js';
import { RequestValidationError } from './requests/engine.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireStaffToken } from '../../core/staff-auth.js';
import { fixedWindowLimiter } from './rate-limit.js';
import { HarnessError, type SupportHarness } from '../agent/harness.js';
import type { CaseStatus } from './contracts.js';
import { seedData } from './seed.js';
import { VersionConflict, type SupportStore } from './store.js';
import { classificationConfigSchema } from '../agent/classification.js';
import { importFromFile, importFromUrl, KnowledgeImportError, knowledgeRuntime } from '../knowledge/runtime.js';
import type { BusinessIntegrations } from '../../integrations/mcp.js';
import { integrationRoutes } from '../../integrations/routes.js';

export interface SupportDependencies {
  harness: SupportHarness; store: SupportStore; workspaceBusinessId?: string;
  integrations?: BusinessIntegrations;
  execution?: 'inline' | 'worker';
  capabilities?: { execution: string; runtime: string; provider: string; model: string; persistence: string; paymentProvider: 'simulated'; credentialsConfigured: boolean; knowledgeSearch: 'lexical' | 'hybrid'; approvals: 'separate-execution'; maxToolCalls: number;
    classification?: { provider: string; model: string; credentialsConfigured: boolean } };
}
interface Options { support: SupportDependencies; operatorToken: string; demoResetEnabled: boolean }

const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const STATUSES: CaseStatus[] = ['open', 'awaiting_approval', 'escalated', 'resolved'];

async function guard(reply: FastifyReply, run: () => Promise<unknown>) {
  try { return await run(); }
  catch (error) {
    if (error instanceof HarnessError) return reply.code(error.status).send({ detail: error.message });
    if (error instanceof RequestValidationError) return reply.code(422).send({ detail: error.message });
    if (error instanceof VersionConflict) return reply.code(409).send({ detail: error.message });
    if (error instanceof z.ZodError) return reply.code(422).send({ detail: error.issues.map(i => i.message).join('; ') });
    throw error;
  }
}

export async function supportRoutes(app: FastifyInstance, { support, operatorToken, demoResetEnabled }: Options) {
  const { harness, store } = support;
  await app.register(integrationRoutes, { support, operatorToken });

  // Customer channel: identity comes only from the X-Customer-Session header, never from message text.
  await app.register(async chat => {
    const session = (headers: Record<string, unknown>) => typeof headers['x-customer-session'] === 'string' ? headers['x-customer-session'] : undefined;
    const hit = fixedWindowLimiter();
    chat.addHook('onRequest', async (request,reply)=>{if(!support.workspaceBusinessId||request.routeOptions.url?.endsWith('/personas'))return;const customer=await store.customerBySession(session(request.headers)??'');if(!customer||customer.businessId!==support.workspaceBusinessId)return reply.code(401).send({detail:'Unknown customer session'});});
    chat.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'POST') return;
      const now = Date.now();
      const sid = session(request.headers);
      // Stop at the IP limit before allocating a bucket for an arbitrary session header.
      const retry = hit(`ip:${request.ip}`, 60, now) || (sid ? hit(`s:${sid}`, 20, now) : 0);
      if (retry) return reply.code(429).header('Retry-After', String(retry)).send({ detail: 'Too many requests' });
    });
    chat.post('/cases', (request, reply) => guard(reply, async () => {
      const created = await harness.openCase(session(request.headers));
      return reply.code(201).send({ id: created.id, status: created.status });
    }));
    chat.get<{ Params: { id: string } }>('/cases/:id', { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
      const { supportCase, messages, activeRun } = await harness.customerCase(session(request.headers), request.params.id);
      const business = await store.business(supportCase.businessId);
      return { id: supportCase.id, status: supportCase.status, ownership: supportCase.ownership, businessName: business?.name ?? '', messages, activeRun };
    }));
    chat.post<{ Params: { id: string }; Body: { body: string; clientMessageId?: string } }>('/cases/:id/messages', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 2000 }, clientMessageId: { type: 'string', format: 'uuid' } } } },
    }, (request, reply) => guard(reply, async () => {
      if (support.execution === 'worker') {
        const accepted = await harness.enqueueTurn(session(request.headers), request.params.id, request.body.body, request.body.clientMessageId);
        return reply.code(202).send({ caseId: accepted.case.id, status: accepted.case.status, ownership: accepted.case.ownership, reply: null, runId: accepted.job?.id ?? null });
      }
      const result = await harness.runTurn(session(request.headers), request.params.id, request.body.body.trim());
      return { caseId: result.case.id, status: result.case.status, ownership: result.case.ownership, reply: result.reply };
    }));
    if (demoResetEnabled) {
      chat.get('/personas', async () => {
        const customers = (await Promise.all(seedData().customers.map(c => store.customer(c.id)))).filter(c => c !== null).filter(c=>businessVisible(support.workspaceBusinessId,c.businessId));
        return Promise.all(customers.map(async c => ({ name: c.name, plan: c.plan, sessionToken: c.sessionToken, businessName: (await store.business(c.businessId))?.name ?? '' })));
      });
    }
  }, { prefix: '/api/v1/chat' });

  // Operator console: bearer OPERATOR_TOKEN.
  await app.register(async operator => {
    operator.addHook('onRequest', async (request, reply) => requireStaffToken(request, reply, operatorToken));
    operator.addHook('preHandler',async(request,reply)=>{
      const binding=support.workspaceBusinessId;if(!binding)return;
      const query=request.query as Record<string,unknown>;const body=request.body as Record<string,unknown>|undefined;const params=request.params as Record<string,string>;const path=request.routeOptions.url??'';
      if(query?.businessId&&query.businessId!==binding||body?.businessId&&body.businessId!==binding)return reply.code(404).send({detail:'Business not found'});
      if(path.includes('/cases/:id')){const row=params.id?await store.getCase(params.id):null;if(!row||row.businessId!==binding)return reply.code(404).send({detail:'Case not found'});}
      if(path.includes('/proposals/:id')){const proposal=params.id?await store.proposal(params.id):null;const row=proposal?await store.getCase(proposal.caseId):null;if(!row||row.businessId!==binding)return reply.code(404).send({detail:'Proposal not found'});}
      if((path.endsWith('/businesses')&&request.method==='POST')||path.endsWith('/demo/reset'))return reply.code(409).send({detail:'This deployment has a fixed workspace'});
    });
    operator.get('/workspace',(request,reply)=>guard(reply,async()=>{
      const businesses=(await store.businessesList()).filter(row=>businessVisible(support.workspaceBusinessId,row.id));
      if(businesses.length!==1)return reply.code(409).send({detail:'Configure an explicit workspace business',code:'workspace_ambiguous'});
      return {business:publicBusiness(businesses[0]!)};
    }));
    operator.get<{ Querystring: { status?: CaseStatus } }>('/cases', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: STATUSES } } } },
    }, async request => (await store.listCases(request.query.status)).filter(row=>businessVisible(support.workspaceBusinessId,row.businessId)));
    operator.get<{ Params: { id: string } }>('/cases/:id', { schema: { params: uuidParams } }, (request, reply) => guard(reply, () => harness.detail(request.params.id)));
    operator.post<{ Params: { id: string; requestId: string } }>('/cases/:id/requests/:requestId/transition', (request, reply) => guard(reply, async () => {
      const params=z.strictObject({id:z.uuid(),requestId:z.uuid()}).parse(request.params);
      const catalog=await store.requestCatalog(params.id);
      if(!await store.getCase(params.id) || !catalog.requests.some(row=>row.id===params.requestId)) throw new HarnessError(404,'Request not found');
      return {requestCatalog:await store.requestTransition(params.id,params.requestId,requestTransitionSchema.parse(request.body),'operator:staff')};
    }));
    operator.post<{ Params: { id: string }; Body: { operator?: string; argsHash: string } }>('/proposals/:id/approve', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['argsHash'], properties: { operator: { type: 'string', maxLength: 80 }, argsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
    }, (request, reply) => guard(reply, async () => {
      const result = await harness.approve(request.params.id, 'staff', request.body.argsHash);
      return reply.send(result);
    }));
    operator.post<{ Params: { id: string }; Body: { argsHash: string } }>('/proposals/:id/execute', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['argsHash'], properties: { argsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
    }, (request, reply) => guard(reply, async () => {
      const result = await harness.executeApproved(request.params.id, 'staff', request.body.argsHash);
      return reply.code(result.proposal.status === 'executed' ? 200 : 502).send(result);
    }));
    operator.post<{ Params: { id: string }; Body: { operator?: string; reason: string } }>('/proposals/:id/reject', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { operator: { type: 'string', maxLength: 80 }, reason: { type: 'string', minLength: 1, maxLength: 500 } } } },
    }, (request, reply) => guard(reply, () => harness.reject(request.params.id, 'staff', z.string().trim().min(1).max(500).parse(request.body.reason))));
    const ownershipBody = z.strictObject({ ownershipVersion: z.number().int().nonnegative().optional() });
    for (const command of ['takeover', 'resume-bot', 'resolve'] as const) {
      operator.post<{ Params: { id: string } }>('/cases/:id/' + command, { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
        const body = ownershipBody.parse(request.body ?? {});
        if (!await store.getCase(request.params.id)) throw new HarnessError(404, 'Case not found');
        let supportCase = command === 'resolve' ? await store.resolveCase(request.params.id,'operator:staff',body.ownershipVersion) : await store.setOwnership(request.params.id, command === 'resume-bot' ? 'bot' : 'staff', 'operator:staff', body.ownershipVersion);
        if(command !== 'resolve') supportCase = await store.updateCase(supportCase.id, { status: command === 'resume-bot' ? 'open' : 'escalated' });
        await store.audit(supportCase.id, 'ownership.' + command, 'operator:staff', { ownershipVersion: supportCase.ownershipVersion });
        return { case: supportCase };
      }));
    }
    operator.post<{ Params: { id: string } }>('/cases/:id/messages', { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
      const body = z.strictObject({ body: z.string().trim().min(1).max(2000), ownershipVersion: z.number().int().nonnegative().optional() }).parse(request.body);
      if (!await store.getCase(request.params.id)) throw new HarnessError(404, 'Case not found');
      const message = await store.staffMessage(request.params.id, body.body, body.ownershipVersion);
      await store.audit(request.params.id, 'staff.replied', 'operator:staff');
      return { message, case: await store.getCase(request.params.id) };
    }));
    operator.get('/businesses', async () => ({ businesses: (await store.businessesList()).filter(row=>businessVisible(support.workspaceBusinessId,row.id)).map(({ id, slug, name, currency }) => ({ id, slug, name, currency })) }));
    operator.post('/businesses', (request, reply) => guard(reply, async () => {
      const body = z.strictObject({ name: z.string().trim().min(1).max(200), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), currency: z.string().regex(/^[A-Z]{3}$/), policy: z.strictObject({ refundLimitCents: z.number().int().positive().max(100000000), duplicateWindowMinutes: z.number().int().positive().max(1440), enabledTools: z.array(z.enum(['lookup_payments', 'refund_payment', 'escalate_to_human'])).max(3) }).default({ refundLimitCents: 50000, duplicateWindowMinutes: 10, enabledTools: ['lookup_payments', 'refund_payment', 'escalate_to_human'] }) }).parse(request.body);
      return reply.code(201).send(await store.createBusiness({ ...body, id: randomUUID() }));
    }));
    operator.post('/customers', (request, reply) => guard(reply, async () => {
      const body = z.strictObject({ businessId: z.uuid(), name: z.string().trim().min(1).max(200), email: z.email().max(254), plan: z.string().trim().min(1).max(80) }).parse(request.body);
      if (!await store.business(body.businessId)) throw new HarnessError(404, 'Business not found');
      const customer = await store.createCustomer({ ...body, id: randomUUID(), sessionToken: randomBytes(32).toString('base64url') });
      const { sessionToken, ...identity } = customer;
      return reply.code(201).send({ customer: identity, sessionToken });
    }));
    const scope = async (query: unknown) => {
      const { businessId } = z.strictObject({ businessId: z.uuid().optional() }).parse(query);
      if(businessId&&!businessVisible(support.workspaceBusinessId,businessId))throw new HarnessError(404,'Business not found');
      const business = businessId ? await store.business(businessId) : support.workspaceBusinessId ? await store.business(support.workspaceBusinessId) : (await store.businessesList())[0];
      if (!business) throw new HarnessError(404, 'Business not found');
      return business.id;
    };
    operator.get('/knowledge', (request, reply) => guard(reply, async () => ({ sources: await store.knowledge(await scope(request.query)), capabilities: { create: true, update: true, publish: true, revoke: true } })));
    // Same retrieval the agent uses for this business: published sources, hybrid BM25 + vector ranking,
    // audience/plan filters as for a customer (audience=any also shows internal sources to staff).
    operator.get('/knowledge/search', (request, reply) => guard(reply, async () => {
      const { q, k, audience, plan, ...rest } = z.strictObject({ q: z.string().trim().min(1).max(500), k: z.coerce.number().int().min(1).max(10).default(5), audience: z.enum(['customer', 'any']).default('customer'), plan: z.string().trim().min(1).max(80).optional(), businessId: z.uuid().optional() }).parse(request.query);
      const businessId = await scope(rest);
      const external = knowledgeRuntime.external;
      if (external?.hasBusiness(businessId)) {
        const started = Date.now();
        try {
          const result = await external.search({ businessId, plan: plan ?? '' }, q);
          return { query: q, mode: 'external', embedder: external.describe(businessId)?.embedder ?? 'configured', tookMs: Date.now() - started,
            hits: result.hits.slice(0, k).map(hit => ({ ...hit, audience: 'customer', score: 0, passages: [{ section: hit.section, text: hit.content, score: 0, lexicalRank: null, vectorRank: null, similarity: null }] })) };
        } catch { throw new HarnessError(502, 'External knowledge search is unavailable; check the server connector configuration'); }
      }
      const published = (await store.knowledge(businessId)).filter(source => source.status === 'published');
      return knowledgeRuntime.retriever.explain(published, q, { k, audience, plan });
    }));
    operator.get('/knowledge/index', (request, reply) => guard(reply, async () => {
      const businessId = await scope(request.query);
      const external = knowledgeRuntime.external?.describe(businessId);
      if (external) return { embedder: { id: external.embedder }, vectorStore: 'qdrant', mode: 'external', readOnly: true, connectorId: external.id, collection: external.collection, chunks: null, staleChunks: null, published: null, documents: null, drafts: null, urlImport: false };
      const sources = await store.knowledge(businessId);
      return { ...await knowledgeRuntime.retriever.status(), mode: 'hybrid', urlImport: knowledgeRuntime.urlAllowlist.length > 0, documents: sources.length, published: sources.filter(s => s.status === 'published').length, drafts: sources.filter(s => s.status === 'draft').length };
    }));
    operator.post('/knowledge/reindex', (request, reply) => guard(reply, async () => {
      const businessId = await scope(request.query);
      if (knowledgeRuntime.external?.hasBusiness(businessId)) throw new HarnessError(409, 'External knowledge is read-only; indexing is managed by the source owner');
      const published = (await store.knowledge(businessId)).filter(source => source.status === 'published');
      return knowledgeRuntime.retriever.reindex(published);
    }));
    operator.get<{ Params: { id: string } }>('/knowledge/:id/versions', { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
      const versions = await store.knowledgeVersions(await scope(request.query), request.params.id);
      if (!versions.length) throw new HarnessError(404, 'Document not found');
      return { versions };
    }));
    const access = { audience: z.enum(['customer', 'internal']).optional(), plans: z.array(z.string().trim().min(1).max(80)).max(20).optional() };
    const importBody = z.strictObject({ category: z.string().trim().min(1).max(80), title: z.string().trim().min(1).max(200).optional(), ...access });
    const imported = async (businessId: string, run: () => Promise<{ title: string; content: string; sourceUrl: string | null }>, fields: { category: string; audience?: 'customer' | 'internal'; plans?: string[] }) => {
      let document;
      try { document = await run(); } catch (error) {
        if (error instanceof KnowledgeImportError) throw new HarnessError(error.status, error.message);
        throw error;
      }
      return store.saveKnowledge({ ...document, content: document.content.slice(0, 100000), category: fields.category, audience: fields.audience ?? 'customer', plans: fields.plans ?? [], id: randomUUID(), businessId, version: 1, status: 'draft', updatedAt: new Date().toISOString() });
    };
    // Imports always create drafts: nothing reaches the AI before an operator publishes it.
    operator.post('/knowledge/import-url', (request, reply) => guard(reply, async () => {
      const body = importBody.extend({ url: z.string().trim().min(1).max(2000) }).parse(request.body);
      return reply.code(201).send(await imported(await scope(request.query), () => importFromUrl(body.url, body.title), body));
    }));
    operator.post('/knowledge/upload', (request, reply) => guard(reply, async () => {
      const body = importBody.extend({ filename: z.string().trim().min(1).max(200), contentBase64: z.string().min(1).max(800_000) }).parse(request.body);
      return reply.code(201).send(await imported(await scope(request.query), async () => importFromFile(body.filename, body.contentBase64, body.title), body));
    }));
    const documentBody = z.strictObject({ title: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(80), content: z.string().trim().min(1).max(100000), ...access });
    operator.post('/knowledge', (request, reply) => guard(reply, async () => {
      const body = documentBody.parse(request.body);
      return reply.code(201).send(await store.saveKnowledge({ ...body, id: randomUUID(), businessId: await scope(request.query), version: 1, status: 'draft', updatedAt: new Date().toISOString() }));
    }));
    operator.patch<{ Params: { id: string } }>('/knowledge/:id', { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
      const body = documentBody.extend({ version: z.number().int().positive() }).parse(request.body);
      const businessId = await scope(request.query);
      const source = (await store.knowledge(businessId)).find(d => d.id === request.params.id);
      if (!source) throw new HarnessError(404, 'Document not found');
      return store.saveKnowledge({ ...source, ...body, version: body.version + 1, status: 'draft', updatedAt: new Date().toISOString() }, body.version);
    }));
    for (const command of ['publish', 'revoke'] as const) {
      operator.post<{ Params: { id: string } }>('/knowledge/:id/' + command, { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
        const { version } = z.strictObject({ version: z.number().int().positive() }).parse(request.body);
        const source = (await store.knowledge(await scope(request.query))).find(d => d.id === request.params.id);
        if (!source) throw new HarnessError(404, 'Document not found');
        return store.saveKnowledge({ ...source, version: version + 1, status: command === 'publish' ? 'published' : 'revoked', updatedAt: new Date().toISOString() }, version);
      }));
    }
    operator.get('/skills', (request, reply) => guard(reply, async () => ({ skills: await store.skills(await scope(request.query)), preset: 'support-v1' })));
    operator.post('/skills', (request, reply) => guard(reply, async () => {
      const body = z.strictObject({ name: z.string().regex(/^custom\/[a-z0-9][a-z0-9-]{0,63}$/), content: z.string().trim().min(1).max(30000), enabled: z.boolean().default(true) }).parse(request.body);
      return reply.code(201).send(await store.saveSkill({ ...body, id: randomUUID(), businessId: await scope(request.query), revision: 1, updatedAt: new Date().toISOString() }));
    }));
    operator.patch<{Params:{id:string}}>('/skills/:id',(request,reply)=>guard(reply,async()=>{
      const businessId=await scope(request.query);const id=z.uuid().parse(request.params.id);const body=z.strictObject({revision:z.number().int().positive(),content:z.string().trim().min(1).max(30000),enabled:z.boolean()}).parse(request.body);
      const old=(await store.skills(businessId)).find(row=>row.id===id);if(!old)throw new HarnessError(404,'Skill not found');
      return store.saveSkill({...old,...body,revision:body.revision+1,updatedAt:new Date().toISOString()},body.revision);
    }));
    operator.get('/guards',(request,reply)=>guard(reply,async()=>{const settings=await store.settings(await scope(request.query));return {version:settings.version,revision:settings.guardRevision??0,rules:settings.guards??[],definitions:guardDefinitions};}));
    operator.put('/guards',(request,reply)=>guard(reply,async()=>{const businessId=await scope(request.query);const body=z.strictObject({version:z.number().int().positive(),rules:guardRulesSchema}).parse(request.body);const old=await store.settings(businessId);const saved=await store.saveSettings({...old,version:body.version+1,guards:body.rules,guardRevision:(old.guardRevision??0)+1},body.version);return {version:saved.version,revision:saved.guardRevision??0,rules:saved.guards??[],definitions:guardDefinitions};}));
    operator.get('/settings', (request, reply) => guard(reply, async () => store.settings(await scope(request.query))));
    operator.patch('/settings', (request, reply) => guard(reply, async () => {
      const body = z.strictObject({ version: z.number().int().positive(), language: z.enum(['uk', 'en']), tone: z.enum(['neutral', 'empathetic', 'de-escalating']), requireApproval: z.literal(true), refundLimitCents: z.number().int().positive().max(100000000), duplicateWindowMinutes: z.number().int().positive().max(1440), enabledTools: z.array(z.enum(['lookup_payments', 'refund_payment', 'escalate_to_human'])).max(3), classification: classificationConfigSchema.nullable().optional() }).parse(request.body);
      return store.saveSettings({ ...body, businessId: await scope(request.query), version: body.version + 1 }, body.version);
    }));
    operator.get('/team', async () => ({ members: [{ id: 'staff', name: 'Оператор', role: 'admin', assignedCases: (await store.listCases()).filter(c=>businessVisible(support.workspaceBusinessId,c.businessId)).filter(c => c.assignedTo === 'operator:staff').length }], capabilities: { invite: false, updateRole: false } }));
    operator.get('/metrics', () => support.workspaceBusinessId?scopedMetrics(store,support.workspaceBusinessId):store.metrics());
    operator.get('/capabilities', () => support.capabilities ?? { runtime: 'injected', provider: 'test', model: 'test', persistence: 'injected', paymentProvider: 'simulated', credentialsConfigured: false, knowledgeSearch: 'hybrid', approvals: 'separate-execution' });
    if (demoResetEnabled) {
      operator.post('/demo/reset', async () => { await store.reset(seedData()); return { status: 'reset' }; });
    }
  }, { prefix: '/api/v1' });
}
