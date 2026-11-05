import type { FastifyReply, FastifyRequest } from 'fastify';
import { staffTokenMatches } from './auth.js';

/** HTTP-only staff guard; legacy jobs and customer authentication remain separate. */
export function requireStaffToken(request: FastifyRequest, reply: FastifyReply, expected: string): FastifyReply | undefined {
  if (!staffTokenMatches(request.headers.authorization, expected)) {
    return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ detail: 'Invalid operator token' });
  }
}
