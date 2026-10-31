import type { FastifyInstance, FastifyReply } from 'fastify';
import { tokenMatches } from '../../core/auth.js';
import { HarnessError, type SupportHarness } from '../agent/harness.js';
import type { CaseStatus } from './contracts.js';
import { seedData } from './seed.js';
import type { SupportStore } from './store.js';

export interface SupportDependencies { harness: SupportHarness; store: SupportStore }
interface Options { support: SupportDependencies; operatorToken: string; demoResetEnabled: boolean }

const uuidParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const STATUSES: CaseStatus[] = ['open', 'awaiting_approval', 'escalated', 'resolved'];

async function guard(reply: FastifyReply, run: () => Promise<unknown>) {
  try { return await run(); }
  catch (error) {
    if (error instanceof HarnessError) return reply.code(error.status).send({ detail: error.message });
    throw error;
  }
}

export async function supportRoutes(app: FastifyInstance, { support, operatorToken, demoResetEnabled }: Options) {
  const { harness, store } = support;

  // Customer channel: identity comes only from the X-Customer-Session header, never from message text.
  await app.register(async chat => {
    const session = (headers: Record<string, unknown>) => typeof headers['x-customer-session'] === 'string' ? headers['x-customer-session'] : undefined;
    chat.post('/cases', (request, reply) => guard(reply, async () => {
      const created = await harness.openCase(session(request.headers));
      return reply.code(201).send({ id: created.id, status: created.status });
    }));
    chat.get<{ Params: { id: string } }>('/cases/:id', { schema: { params: uuidParams } }, (request, reply) => guard(reply, async () => {
      const { supportCase, messages } = await harness.customerCase(session(request.headers), request.params.id);
      const business = await store.business(supportCase.businessId);
      return { id: supportCase.id, status: supportCase.status, businessName: business?.name ?? '', messages };
    }));
    chat.post<{ Params: { id: string }; Body: { body: string } }>('/cases/:id/messages', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 2000 } } } },
    }, (request, reply) => guard(reply, async () => {
      const result = await harness.runTurn(session(request.headers), request.params.id, request.body.body.trim());
      return { caseId: result.case.id, status: result.case.status, reply: result.reply };
    }));
    if (demoResetEnabled) {
      chat.get('/personas', async () => {
        const customers = (await Promise.all(seedData().customers.map(c => store.customer(c.id)))).filter(c => c !== null);
        return Promise.all(customers.map(async c => ({ name: c.name, plan: c.plan, sessionToken: c.sessionToken, businessName: (await store.business(c.businessId))?.name ?? '' })));
      });
    }
  }, { prefix: '/api/v1/chat' });

  // Operator console: bearer OPERATOR_TOKEN.
  await app.register(async operator => {
    operator.addHook('onRequest', async (request, reply) => {
      if (!tokenMatches(request.headers.authorization, operatorToken)) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ detail: 'Invalid operator token' });
      }
    });
    operator.get<{ Querystring: { status?: CaseStatus } }>('/cases', {
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: STATUSES } } } },
    }, request => store.listCases(request.query.status));
    operator.get<{ Params: { id: string } }>('/cases/:id', { schema: { params: uuidParams } }, (request, reply) => guard(reply, () => harness.detail(request.params.id)));
    operator.post<{ Params: { id: string }; Body: { operator: string; argsHash: string } }>('/proposals/:id/approve', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['operator', 'argsHash'], properties: { operator: { type: 'string', minLength: 1, maxLength: 80 }, argsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
    }, (request, reply) => guard(reply, async () => {
      const result = await harness.approve(request.params.id, request.body.operator, request.body.argsHash);
      return reply.code(result.proposal.status === 'executed' ? 200 : 502).send(result);
    }));
    operator.post<{ Params: { id: string }; Body: { operator: string; reason: string } }>('/proposals/:id/reject', {
      schema: { params: uuidParams, body: { type: 'object', additionalProperties: false, required: ['operator', 'reason'], properties: { operator: { type: 'string', minLength: 1, maxLength: 80 }, reason: { type: 'string', minLength: 1, maxLength: 500 } } } },
    }, (request, reply) => guard(reply, () => harness.reject(request.params.id, request.body.operator, request.body.reason)));
    operator.get('/metrics', () => store.metrics());
    if (demoResetEnabled) {
      operator.post('/demo/reset', async () => { await store.reset(seedData()); return { status: 'reset' }; });
    }
  }, { prefix: '/api/v1' });
}
