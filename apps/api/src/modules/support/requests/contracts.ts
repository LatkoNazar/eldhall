import { z } from 'zod';

export interface RequestActionLink { proposalId: string; requestRevision: number }
export interface RequestProof { proposalIds: string[]; messageIds: string[] }
export interface CustomerRequest {
  id: string; number: number; revision: number; title: string; goal: string;
  lifecycle: 'open' | 'fulfilled' | 'cancelled'; waitingOn: 'customer' | 'staff' | null;
  nextStep: string | null; sourceMessageIds: string[]; dependencyIds: string[];
  actions: RequestActionLink[]; createdAt: string; updatedAt: string; updatedBy: string;
  fulfillment: { reason: string; proof: RequestProof; actor: string; at: string } | null;
}
export interface RequestEvent {
  id: string; requestId: string; revision: number; type: 'created' | 'updated' | 'sources_linked' | 'action_linked' | 'fulfilled' | 'cancelled' | 'reopened';
  actor: string; at: string; reason: string | null; snapshot: CustomerRequest;
}
export interface RequestCatalog {
  version: number; syncState: 'current' | 'needs_review'; lastSourceMessageId: string | null;
  requests: CustomerRequest[];
  history: { events: RequestEvent[]; hasMore: boolean };
}
const text = (max: number) => z.string().trim().min(1).max(max);
const ids = z.array(z.uuid()).max(30).refine(values => new Set(values).size === values.length, 'Duplicate references');
export const requestChangeSchema = z.strictObject({
  localKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  id: z.uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  title: text(160), goal: text(1200), waitingOn: z.enum(['customer', 'staff']).nullable(),
  nextStep: text(500).nullable(), sourceMessageIds: ids.min(1),
  dependencyIds: ids.default([]), dependencyKeys: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(20).default([]),
});
export const requestCheckpointSchema = z.strictObject({
  version: z.number().int().nonnegative(), syncState: z.enum(['current', 'needs_review']),
  changes: z.array(requestChangeSchema).max(20),
});
export type RequestCheckpoint = z.infer<typeof requestCheckpointSchema>;
export const requestTransitionSchema = z.strictObject({
  version: z.number().int().nonnegative(), revision: z.number().int().positive(),
  transition: z.enum(['fulfill', 'cancel', 'reopen']), reason: text(800),
  proof: z.strictObject({ proposalIds: ids, messageIds: ids }),
});
export type RequestTransition = z.infer<typeof requestTransitionSchema>;
export const requestTargetsSchema = z.array(z.strictObject({ id: z.uuid(), revision: z.number().int().positive() })).min(1).max(100);
export type RequestTarget = z.infer<typeof requestTargetsSchema>[number];
