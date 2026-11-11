import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IntegrationStore } from '../../integrations/state.js';
import { guardRuleSchema, type GuardRule } from './guards.js';

export const guardDraftRequest = z.strictObject({ description: z.string().trim().min(10).max(6_000), guardId: z.uuid().optional() });
const outputSchema = z.strictObject({ guard: z.record(z.string(), z.unknown()).nullable() });

export interface GuardDraftInput {
  description: string;
  currency: string;
  editingGuardId?: string;
  existingGuards: GuardRule[];
  targets: {
    tools: ['refund_payment', 'external_action'];
    integrations: { integrationId: string; operations: { operationKey: string; title: string }[] }[];
  };
}

export interface GuardDraftModel {
  generate(input: GuardDraftInput, businessId: string, signal: AbortSignal): Promise<unknown>;
}

type GuardDraftRejectionCode = 'guard_draft_unsupported' | 'guard_draft_duplicate' | 'guard_draft_currency' | 'guard_draft_target' | 'guard_draft_context' | 'guard_draft_limit';

export class GuardDraftRejection extends Error {
  constructor(readonly code: GuardDraftRejectionCode, detail: string) { super(detail); }
}

/** Only a bounded, reviewed catalog from the selected workspace is shown to the model. */
export async function guardDraftContext(registry: IntegrationStore, businessId: string, description: string, currency: string, existingGuards: GuardRule[], editing?: GuardRule) {
  const query = description.toLowerCase();
  const mentioned = (...values: string[]) => values.some(value => value.length > 0 && query.includes(value.toLowerCase()));
  const priority = (id: string) => id === editing?.target.integrationId ? 2 : Number(mentioned(id));
  const states = (await registry.list(businessId))
    .filter(state => state.enabled && !state.draining && state.activeManifestHash === state.loadedManifestHash)
    .sort((a, b) => priority(b.integrationId) - priority(a.integrationId) || a.integrationId.localeCompare(b.integrationId))
    .slice(0, 12);
  const integrations = (await Promise.all(states.map(async state => {
    const manifest = await registry.manifest(businessId, state.integrationId, state.loadedManifestHash);
    if (!manifest) return null;
    const review = new Map(state.policy.operations.map(rule => [rule.operationKey, rule]));
    const rank = (operation: typeof manifest.operations[number]) => operation.operationKey === editing?.target.operationKey ? 2 : Number(mentioned(operation.operationKey, operation.title, operation.toolName));
    const operations = manifest.operations.filter(operation => {
      const rule = review.get(operation.operationKey);
      return operation.effect === 'write' && rule?.enabled && rule.reviewedOperationHash === operation.operationHash;
    }).sort((a, b) => rank(b) - rank(a) || a.operationKey.localeCompare(b.operationKey)).slice(0, 6)
      .map(({ operationKey, title }) => ({ operationKey, title: title.slice(0, 100) }));
    return operations.length ? { integrationId: state.integrationId, operations } : null;
  }))).filter(integration => integration !== null);
  const input: GuardDraftInput = { description, currency, editingGuardId: editing?.id, existingGuards, targets: { tools: ['refund_payment', 'external_action'], integrations } };
  if (Buffer.byteLength(JSON.stringify(input)) > 48_000) throw new GuardDraftRejection('guard_draft_context', 'Guard drafting context is too large. Use a shorter description and try again.');
  return { input, states };
}

export function reviewGuardDraft(input: GuardDraftInput, output: unknown, editing?: GuardRule): GuardRule {
  const { guard } = outputSchema.parse(output);
  if (!guard) throw new GuardDraftRejection('guard_draft_unsupported', 'Describe one supported restriction: deny an action, require approval, or limit refunds in the workspace currency.');
  if (['id', 'enabled', 'definitionVersion'].some(key => Object.hasOwn(guard, key))) throw new Error('Unexpected guard draft metadata');
  const draft = guardRuleSchema.parse({ ...guard, id: editing?.id ?? randomUUID(), enabled: editing?.enabled ?? false, definitionVersion: 1 });
  if (draft.kind === 'amount_limit' && draft.currency !== input.currency) throw new GuardDraftRejection('guard_draft_currency', `A refund limit must use the workspace currency (${input.currency}).`);
  const { integrationId, operationKey } = draft.target;
  if (draft.target.tool === 'external_action') {
    if (!integrationId || !operationKey) throw new GuardDraftRejection('guard_draft_target', 'Select one reviewed external write operation. Broad external action guards cannot be drafted.');
    const integration = input.targets.integrations.find(row => row.integrationId === integrationId);
    if (!integration?.operations.some(operation => operation.operationKey === operationKey)) throw new Error('Invalid guard draft target');
  }
  const duplicate = input.existingGuards.some(rule => rule.id !== draft.id && rule.kind === draft.kind
    && rule.target.tool === draft.target.tool && rule.target.integrationId === integrationId && rule.target.operationKey === operationKey
    && (rule.kind !== 'amount_limit' || draft.kind === 'amount_limit' && rule.maxAmountCents === draft.maxAmountCents && rule.currency === draft.currency));
  if (duplicate) throw new GuardDraftRejection('guard_draft_duplicate', 'An equivalent guard already exists. Edit that guard or describe a different restriction.');
  return draft;
}
