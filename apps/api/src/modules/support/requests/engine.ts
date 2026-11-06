import { hasUnrepresentedInput, isAcknowledgement } from './text.js';
import { randomUUID } from 'node:crypto';
import type { CaseStatus, Message, Proposal, SupportCase } from '../contracts.js';
import { VersionConflict } from '../store.js';
import { requestCheckpointSchema, requestTargetsSchema, requestTransitionSchema, type CustomerRequest, type RequestCatalog, type RequestCheckpoint, type RequestEvent, type RequestTarget, type RequestTransition } from './contracts.js';

export const emptyCatalog = (): RequestCatalog => ({ version: 0, syncState: 'needs_review', lastSourceMessageId: null, requests: [], history: { events: [], hasMore: false } });
export const publicCatalog = (catalog: RequestCatalog): RequestCatalog => ({ ...structuredClone(catalog), history: { events: structuredClone(catalog.history.events.slice(-100)), hasMore: catalog.history.hasMore || catalog.history.events.length > 100 } });
export class RequestValidationError extends Error {}
export function aggregateRequestStatus(catalog: RequestCatalog, requested: CaseStatus, ownership: SupportCase['ownership'], proposals: Proposal[]): CaseStatus {
  if (requested !== 'resolved' || !catalog.requests.length) return requested;
  const pending = proposals.some(proposal => ['pending','approved','executing'].includes(proposal.status));
  if (catalog.syncState === 'needs_review' || catalog.requests.some(row => row.lifecycle === 'open') || pending || proposals.some(proposal => proposal.status === 'unknown')) {
    return ownership === 'staff' ? 'escalated' : pending ? 'awaiting_approval' : 'open';
  }
  return requested;
}
function invalid(message: string): never { throw new RequestValidationError(message); }
const event = (row: CustomerRequest, type: RequestEvent['type'], actor: string, at: string, reason: string | null = null): RequestEvent => ({ id: randomUUID(), requestId: row.id, revision: row.revision, type, actor, at, reason, snapshot: structuredClone(row) });
const unique = (values: string[]) => [...new Set(values)];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function applyCheckpoint(current: RequestCatalog, input: RequestCheckpoint, sourceMessageId: string, messages: Message[], actor: string) {
  const batch = requestCheckpointSchema.parse(input);
  if (current.version !== batch.version) throw new VersionConflict('Request catalog changed');
  const source = messages.find(message => message.id === sourceMessageId && message.role === 'customer');
  if (!source) invalid('Current customer message is not in this conversation');
  if (!batch.changes.length && batch.syncState === 'current' && !isAcknowledgement(source.body)) invalid('Unrepresented customer input requires review');
  if (new Set(batch.changes.map(change => change.localKey)).size !== batch.changes.length) invalid('Duplicate local request key');
  const existingIds = batch.changes.flatMap(change => change.id ? [change.id] : []);
  if (new Set(existingIds).size !== existingIds.length) invalid('Request updated more than once');
  const keys = new Map(batch.changes.map(change => [change.localKey, change.id ?? randomUUID()]));
  const next = structuredClone(current); const at = new Date().toISOString(); const invalidated = new Set<string>();
  for (const change of batch.changes) {
    const id = keys.get(change.localKey)!; const old = next.requests.find(row => row.id === id);
    if (change.id && (!old || old.revision !== change.expectedRevision)) throw new VersionConflict('Request revision changed');
    if (!change.id && change.expectedRevision !== undefined) invalid('New request cannot have a revision');
    if (old && old.lifecycle !== 'open') invalid('Reopen a closed request before changing its goal');
    if (!change.sourceMessageIds.includes(sourceMessageId) || change.sourceMessageIds.some(ref => !messages.some(message => message.id === ref && message.role === 'customer'))) invalid('Request sources must be customer messages from this conversation');
    const dependencies = unique([...change.dependencyIds, ...change.dependencyKeys.map(key => keys.get(key) ?? invalid('Unknown dependency key'))]).sort();
    const material = !old || old.goal !== change.goal || !equal([...old.dependencyIds].sort(), dependencies);
    const sources = unique([...(old?.sourceMessageIds ?? []), ...change.sourceMessageIds]);
    const row: CustomerRequest = { id, number: old?.number ?? next.requests.reduce((max, row) => Math.max(max, row.number), 0) + 1,
      revision: old ? old.revision + (material ? 1 : 0) : 1, title: change.title, goal: change.goal,
      lifecycle: 'open', waitingOn: change.waitingOn, nextStep: change.nextStep, sourceMessageIds: sources, dependencyIds: dependencies,
      actions: old?.actions ?? [], createdAt: old?.createdAt ?? at, updatedAt: at, updatedBy: actor, fulfillment: null };
    if (old) next.requests[next.requests.findIndex(row => row.id === id)] = row; else next.requests.push(row);
    if (material && old) for (const link of old.actions) invalidated.add(link.proposalId);
    next.history.events.push(event(row, !old ? 'created' : material ? 'updated' : 'sources_linked', actor, at));
  }
  if (next.requests.some(row => row.sourceMessageIds.length > 100)) invalid('Request source limit reached');
  if (next.requests.length > 100) invalid('Conversation request limit reached');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const walk = (id: string) => { if (visiting.has(id)) invalid('Request dependencies cannot form a cycle'); if (visited.has(id)) return;
    const row = next.requests.find(row => row.id === id); if (!row) invalid('Dependency is not in this conversation');
    visiting.add(id); for (const dependency of row.dependencyIds) walk(dependency); visiting.delete(id); visited.add(id); };
  for (const row of next.requests) walk(row.id);
  next.version++; next.syncState = hasUnrepresentedInput(next.requests,messages.filter(message=>message.role==='customer')) ? 'needs_review' : batch.syncState; next.lastSourceMessageId = sourceMessageId;
  return { catalog: next, invalidated: [...invalidated] };
}
export function targetsAllowed(catalog: RequestCatalog, targets: RequestTarget[], handoff = false) {
  return targets.length > 0 && targets.every(target => { const row = catalog.requests.find(row => row.id === target.id);
    return row?.revision === target.revision && row.lifecycle === 'open' && (handoff || row.waitingOn !== 'customer' && row.dependencyIds.every(id => catalog.requests.some(dependency => dependency.id === id && dependency.lifecycle === 'fulfilled'))); });
}
export function actionAllowed(catalog: RequestCatalog, proposalId: string, handoff = false) {
  const targets = catalog.requests.flatMap(row => row.actions.filter(link => link.proposalId === proposalId).map(link => ({ id: row.id, revision: link.requestRevision })));
  return !targets.length || targetsAllowed(catalog, targets, handoff);
}
export function linkAction(current: RequestCatalog, targets: RequestTarget[], proposalId: string, actor: string, handoff = false): RequestCatalog {
  const parsed = requestTargetsSchema.parse(targets);
  if (new Set(parsed.map(target => target.id)).size !== parsed.length || !targetsAllowed(current, parsed, handoff)) throw new VersionConflict('Request goal changed or a prerequisite is incomplete');
  const next = structuredClone(current); const at = new Date().toISOString(); let changed = false;
  for (const target of parsed) { const row = next.requests.find(row => row.id === target.id)!;
    const old = row.actions.find(link => link.proposalId === proposalId);
    if (old) { if (old.requestRevision !== target.revision) throw new VersionConflict('Action already belongs to another request revision'); continue; }
    if(row.actions.length>=100) invalid('Request action history limit reached');
    row.actions.push({ proposalId, requestRevision: target.revision }); row.updatedAt = at; row.updatedBy = actor; changed = true;
    next.history.events.push(event(row, 'action_linked', actor, at)); }
  if (changed) next.version++;
  return next;
}
export function transitionRequest(current: RequestCatalog, id: string, input: RequestTransition, messages: Message[], proposals: Proposal[], actor: string) {
  const change = requestTransitionSchema.parse(input); const next = structuredClone(current); const row = next.requests.find(row => row.id === id);
  if (!row) invalid('Request not found');
  if (next.version !== change.version || row.revision !== change.revision) throw new VersionConflict('Request catalog or revision changed');
  const linked = proposals.filter(proposal => row.actions.some(link => link.proposalId === proposal.id));
  if (linked.some(proposal => proposal.status === 'unknown' || proposal.status === 'executing')) throw new VersionConflict('Reconcile the recorded action before changing this request');
  if (change.proof.messageIds.some(id => !messages.some(message => message.id === id)) || change.proof.proposalIds.some(id => !linked.some(proposal => proposal.id === id && proposal.status === 'executed' && row.actions.some(link => link.proposalId === id && link.requestRevision === row.revision)))) invalid('Completion proof is not a recorded result of this request revision');
  if (change.transition === 'fulfill') {
    if (row.lifecycle !== 'open' || linked.some(proposal => ['pending', 'approved'].includes(proposal.status))) throw new VersionConflict('Finish or reject pending actions before fulfilling the request');
    if (row.dependencyIds.some(id => !next.requests.some(dependency => dependency.id === id && dependency.lifecycle === 'fulfilled'))) throw new VersionConflict('Request prerequisites are incomplete');
    if (!change.proof.proposalIds.length && !change.proof.messageIds.some(id => messages.some(message => message.id === id && (['operator','customer'].includes(message.role) && !row.sourceMessageIds.includes(id) && Date.parse(message.createdAt) >= Date.parse(row.updatedAt))))) invalid('Fulfillment requires a recorded action or new customer/operator confirmation after the current request update');
    row.lifecycle = 'fulfilled'; row.fulfillment = { reason: change.reason, proof: change.proof, actor, at: new Date().toISOString() };
  } else if (change.transition === 'cancel') { if (row.lifecycle !== 'open') throw new VersionConflict('Request is already closed'); row.lifecycle = 'cancelled'; }
  else { if (row.lifecycle === 'open') throw new VersionConflict('Request is already open'); row.lifecycle = 'open'; row.fulfillment = null; }
  if (next.requests.every(request => request.lifecycle !== 'open') && !hasUnrepresentedInput(next.requests,messages.filter(message=>message.role==='customer'))) next.syncState = 'current';
  row.revision++; row.updatedAt = new Date().toISOString(); row.updatedBy = actor; row.waitingOn = null; row.nextStep = null; next.version++;
  next.history.events.push(event(row, change.transition === 'fulfill' ? 'fulfilled' : change.transition === 'cancel' ? 'cancelled' : 'reopened', actor, row.updatedAt, change.reason));
  return { catalog: next, invalidated: row.actions.map(link => link.proposalId) };
}
