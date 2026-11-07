import { z } from 'zod';
import type { MessageRole, ProposalStatus } from '../support/contracts.js';
import type { RequestCatalog } from '../support/requests/contracts.js';

export interface ContextMessage { id: string; role: MessageRole; body: string }
export interface ContextSkill { id: string; name: string; revision: number; content: string }
export interface ContextSkillMetadata { id: string; name: string; revision: number; purpose: string; activation: 'always' | 'on_demand' }
export interface ContextToolRef { integrationId: string; name: string }
export interface SupportContextCatalog {
  skills: ContextSkillMetadata[];
  tools: (ContextToolRef & { description: string; arguments: string[]; batchRead?: true })[];
}
export interface SupportContextMemory {
  schemaVersion: 1;
  currentMessage: ContextMessage;
  recentMessages: ContextMessage[];
  requestCatalog: Pick<RequestCatalog, 'version' | 'syncState' | 'lastSourceMessageId'> & {
    requests: Pick<RequestCatalog['requests'][number], 'id' | 'number' | 'revision' | 'title' | 'goal' | 'lifecycle' | 'waitingOn' | 'nextStep' | 'sourceMessageIds' | 'dependencyIds' | 'actions'>[];
  };
  actions: { id: string; tool: string; status: ProposalStatus; authorizationOrigin: string | null; requestIds: string[]; createdAt: string }[];
  facts: { kind: 'recorded_action'; actionId: string; status: 'executed'; recordedAt: string }[];
  sourceCoverage: { olderMessagesAvailable: boolean; uncheckpointedMessageIds: string[] };
}
const id = z.string().min(1).max(128);
export const supportContextRequestSchema = z.strictObject({
  skillIds: z.array(id).max(4).optional(),
  toolRefs: z.array(z.strictObject({ integrationId: id, name: id })).max(4).optional(),
  messageIds: z.array(id).max(8).optional(),
}).refine(request => (request.skillIds?.length ?? 0) + (request.toolRefs?.length ?? 0) + (request.messageIds?.length ?? 0) > 0, 'Select context details by their advertised IDs');
export type SupportContextRequest = z.infer<typeof supportContextRequestSchema>;
export interface SupportContextDetails {
  skills: (ContextSkill & { contentHash: string })[];
  tools: (ContextToolRef & { description: string; inputSchema: Record<string, unknown> })[];
  messages: ContextMessage[];
}

/** Tiny metadata profile, not a YAML evaluator. Unknown or malformed activation stays mandatory. */
export function parseSkillContext(skill: Pick<ContextSkill, 'name' | 'content'>) {
  const source = skill.content.replace(/^\uFEFF/, '');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  const lines = header?.[1]?.split(/\r?\n/) ?? [];
  const activations = lines.flatMap(line => /^activation:\s*(.*?)\s*$/.exec(line)?.[1] ?? []);
  const descriptions = lines.flatMap(line => /^description:\s*(.*?)\s*$/.exec(line)?.[1] ?? []);
  const plain = (value: string) => value.replace(/^(['"])(.*)\1$/, '$2');
  const activation = activations.length === 1 ? plain(activations[0]!) : undefined;
  const description = descriptions.length === 1 ? plain(descriptions[0]!).trim() : '';
  const valid = !!header && ['always', 'on_demand'].includes(activation ?? '') && description.length > 0 && description.length <= 240 && !/^[|>[{&*!]/.test(description);
  return {
    activation: valid && activation === 'on_demand' ? 'on_demand' as const : 'always' as const,
    purpose: valid ? description : skill.name,
    content: valid ? source.slice(header![0].length) : skill.content,
  };
}
