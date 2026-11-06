import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireStaffToken } from '../../core/staff-auth.js';
import { InsightError } from './contracts.js';
import type { InsightsService } from './service.js';

const businessQuery = z.strictObject({ businessId: z.uuid() });
const runParams = z.strictObject({ runId: z.uuid() });
const createBody = z.strictObject({ businessId: z.uuid(), limit: z.number().int().min(1).max(25).default(25), clientRequestId: z.uuid().optional() });
const findingParams = runParams.extend({ findingId: z.uuid() });
async function guard(reply: FastifyReply, action: () => Promise<unknown>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof InsightError) return reply.code(error.status).send({ detail: error.message });
    if (error instanceof z.ZodError) return reply.code(422).send({ detail: error.issues.map(issue => issue.message).join('; ') });
    throw error;
  }
}
export async function insightsRoutes(app: FastifyInstance, options: { insights: InsightsService; operatorToken: string; workspaceBusinessId?: string }) {
  app.addHook('onRequest', async (request, reply) => requireStaffToken(request, reply, options.operatorToken));
  app.addHook('preHandler',async(request,reply)=>{if(!options.workspaceBusinessId)return;const businessId=(request.query as Record<string,unknown>)?.businessId??(request.body as Record<string,unknown>|undefined)?.businessId;if(businessId!==options.workspaceBusinessId)return reply.code(404).send({detail:'Business not found'});});
  app.get('/runs', (request, reply) => guard(reply, async () => ({ runs: await options.insights.repository.list(businessQuery.parse(request.query).businessId) })));
  app.post('/runs', (request, reply) => guard(reply, async () => {
    const body = createBody.parse(request.body);
    return reply.code(202).send(await options.insights.create(body.businessId, body.limit, body.clientRequestId));
  }));
  app.get('/runs/:runId', (request, reply) => guard(reply, async () => options.insights.repository.get(businessQuery.parse(request.query).businessId, runParams.parse(request.params).runId)));
  app.post('/runs/:runId/findings/:findingId/draft', (request, reply) => guard(reply, async () => {
    if (request.body !== undefined && request.body !== null) z.strictObject({}).parse(request.body);
    const { runId, findingId } = findingParams.parse(request.params);
    return { draft: await options.insights.repository.draft(businessQuery.parse(request.query).businessId, runId, findingId) };
  }));
}
