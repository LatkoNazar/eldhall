import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Settings } from './core/config.js';
import { hostAllowed, tokenMatches } from './core/auth.js';
import type { JobStore } from './modules/jobs/repository.js';
import { jobCreateSchema, jobReadSchema, type JobCreate, type Job } from './modules/jobs/schema.js';
import { createJob, QueueUnavailable } from './modules/jobs/service.js';
import { readiness, type Checks } from './modules/system/health.js';
import { supportRoutes, type SupportDependencies } from './modules/support/routes.js';
import { insightsRoutes } from './modules/insights/routes.js';
import type { InsightsService } from './modules/insights/service.js';

export interface AppDependencies { store: JobStore; dispatch: (id: string) => Promise<void>; checks: Checks; readJob?: (id: string) => Promise<Job | null>; support?: SupportDependencies; insights?: InsightsService }

export async function createApp(settings: Settings, dependencies: AppDependencies, logging = false) {
  const app = Fastify({
    logger: logging ? { redact: ['req.headers.authorization'], serializers: { err: () => ({ type: 'Error', message: 'Internal error', stack: '' }) } } : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } },
    bodyLimit: 1048576,
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!hostAllowed(request.headers.host, settings.allowedHosts)) {
      return reply.code(400).type('text/plain').send('Invalid host header');
    }
  });
  const anyOrigin = settings.corsOrigins.includes('*');
  const corsMethods = ['GET', 'POST', 'PATCH'];
  const corsHeaders = ['Accept', 'Accept-Language', 'Authorization', 'Content-Language', 'Content-Type', 'X-Customer-Session'];
  const allowedHeaders = new Set(corsHeaders.map(header => header.toLowerCase()));
  await app.register(cors, { origin: anyOrigin ? '*' : settings.corsOrigins, methods: corsMethods, allowedHeaders: corsHeaders, credentials: false, preflight: false });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const method = request.headers['access-control-request-method'];
    if (request.method !== 'OPTIONS' || !origin || !method) return;
    const failures: string[] = [];
    const allowedOrigin = anyOrigin || settings.corsOrigins.includes(origin);
    if (!allowedOrigin) failures.push('origin');
    if (!corsMethods.includes(String(method))) failures.push('method');
    const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').split(',').map(header => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some(header => !allowedHeaders.has(header))) failures.push('headers');
    if (!anyOrigin) reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Methods', corsMethods.join(', '))
      .header('Access-Control-Max-Age', '600')
      .header('Access-Control-Allow-Headers', corsHeaders.join(', '));
    if (allowedOrigin) reply.header('Access-Control-Allow-Origin', anyOrigin ? '*' : origin);
    return reply.code(failures.length ? 400 : 200).type('text/plain').send(failures.length ? `Disallowed CORS ${failures.join(', ')}` : 'OK');
  });
  if (settings.environment === 'development') {
    await app.register(swagger, { openapi: { info: { title: 'Competition Starter', version: '0.1.0' } } });
    await app.register(swaggerUi, { routePrefix: '/docs' });
    app.get('/openapi.json', () => app.swagger());
  }
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.validation) return reply.code(422).send({ detail: error.validation.map(issue => ({
      loc: [error.validationContext, ...issue.instancePath.split('/').filter(Boolean)],
      msg: issue.message ?? 'Invalid value', type: issue.keyword,
    })) });
    if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(422).send({ detail: [{ loc: ['body'], msg: 'Invalid JSON', type: 'json_invalid' }] });
    }
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ detail: error.message });
    app.log.error({ err: error }, 'Request failed');
    return reply.code(500).send({ detail: 'Internal server error' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ detail: 'Not Found' }));
  app.get('/health/live', () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const checks = await readiness(dependencies.checks);
    const healthy = Object.values(checks).every(value => value === 'ok');
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'unavailable', dependencies: checks });
  });
  await app.register(async jobs => {
    jobs.addHook('onRequest', async (request, reply) => {
      if (!tokenMatches(request.headers.authorization, settings.apiToken)) {
        return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ detail: 'Invalid API token' });
      }
    });
    jobs.post<{ Body: JobCreate }>('', { schema: { body: jobCreateSchema, response: { 202: jobReadSchema } } }, async (request, reply) => {
      try { return reply.code(202).send(await createJob(dependencies.store, request.body, dependencies.dispatch)); }
      catch (error) {
        if (error instanceof QueueUnavailable) return reply.code(503).send({ detail: error.message });
        throw error;
      }
    });
    jobs.get<{ Params: { jobId: string } }>('/:jobId', {
      schema: { params: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string', format: 'uuid' } } }, response: { 200: jobReadSchema } },
    }, async (request, reply) => {
      const job = await (dependencies.readJob ?? dependencies.store.find.bind(dependencies.store))(request.params.jobId);
      if (!job) return reply.code(404).send({ detail: 'Job not found' });
      return job;
    });
  }, { prefix: '/api/v1/jobs' });
  if (dependencies.support) {
    await app.register(supportRoutes, { support: dependencies.support, operatorToken: settings.operatorToken, demoResetEnabled: settings.demoResetEnabled });
  }
  if (dependencies.insights) await app.register(insightsRoutes, { prefix: '/api/v1/insights', insights: dependencies.insights, operatorToken: settings.operatorToken });
  return app;
}
