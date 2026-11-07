import type { Proposal } from '../support/contracts.js';
import type { RequestCatalog } from '../support/requests/contracts.js';
import type { ContextMessage, SupportContextMemory } from './context.js';
import { SupportContextError } from './context-access.js';

/** Deterministic projection of authoritative records; no model-written summary or provider-specific cache. */
export function buildSupportContextMemory(input: {
  currentMessageId: string;
  messages: ContextMessage[];
  requestCatalog: RequestCatalog;
  proposals: Proposal[];
  recentMessageLimit?: number;
}): SupportContextMemory {
  const cutoff = input.messages.findIndex(message => message.id === input.currentMessageId);
  if (cutoff < 0 || input.messages[cutoff]!.role !== 'customer') throw new SupportContextError();
  const unique = new Map<string, ContextMessage>();
  for (const message of input.messages.slice(0, cutoff + 1)) {
    const previous = unique.get(message.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new SupportContextError();
    unique.set(message.id, structuredClone(message));
  }
  const messages = [...unique.values()], currentMessage = unique.get(input.currentMessageId)!;
  const checkpointAt = input.requestCatalog.lastSourceMessageId
    ? messages.findIndex(message => message.id === input.requestCatalog.lastSourceMessageId) : -1;
  if (input.requestCatalog.lastSourceMessageId && checkpointAt < 0) throw new SupportContextError();
  const uncheckpointed = messages.slice(checkpointAt + 1).filter(message => message.role === 'customer');
  const keep = new Set([
    ...messages.slice(-Math.max(1, Math.min(input.recentMessageLimit ?? 10, 30))).map(message => message.id),
    ...uncheckpointed.map(message => message.id),
  ]);
  const recentMessages = messages.filter(message => message.id !== currentMessage.id && keep.has(message.id));
  const requestCatalog = {
    version: input.requestCatalog.version, syncState: input.requestCatalog.syncState, lastSourceMessageId: input.requestCatalog.lastSourceMessageId,
    requests: input.requestCatalog.requests.map(({ id, number, revision, title, goal, lifecycle, waitingOn, nextStep, sourceMessageIds, dependencyIds, actions }) =>
      ({ id, number, revision, title, goal, lifecycle, waitingOn, nextStep, sourceMessageIds: [...sourceMessageIds], dependencyIds: [...dependencyIds], actions: structuredClone(actions) })),
  };
  const unresolved = input.proposals.filter(proposal => ['pending', 'approved', 'executing', 'unknown'].includes(proposal.status));
  const actions = unresolved.map(proposal => ({
    id: proposal.id, tool: proposal.tool, status: proposal.status, authorizationOrigin: proposal.authorizationOrigin ?? null, createdAt: proposal.createdAt,
    requestIds: requestCatalog.requests.filter(request => request.actions.some(action => action.proposalId === proposal.id)).map(request => request.id),
  }));
  const facts = input.proposals.filter(proposal => proposal.status === 'executed').map(proposal => ({
    kind: 'recorded_action' as const, actionId: proposal.id, status: 'executed' as const, recordedAt: proposal.decidedAt ?? proposal.createdAt,
  }));
  const result: SupportContextMemory = {
    schemaVersion: 1, currentMessage, recentMessages, requestCatalog, actions, facts,
    sourceCoverage: { olderMessagesAvailable: messages.some(message => message.id !== currentMessage.id && !keep.has(message.id)), uncheckpointedMessageIds: uncheckpointed.map(message => message.id) },
  };
  // Required state is never silently trimmed. A too-large ticket is explicitly unavailable to this turn.
  if (Buffer.byteLength(JSON.stringify(result)) > 131_072) throw new SupportContextError();
  return result;
}
