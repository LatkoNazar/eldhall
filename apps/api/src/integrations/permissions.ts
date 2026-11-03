import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Deterministic auto/ask/deny resolver for imported business operations (TODO.md §4.2, §5.1).
 * Pure: no I/O. Missing or malformed policy always resolves to deny. Absolute business guards,
 * scope and ownership checks are separate and cannot be overridden by anything decided here.
 */
export type PermissionMode = 'auto' | 'ask' | 'deny';
const mode = z.enum(['auto', 'ask', 'deny']);
const ruleMode = z.enum(['auto', 'ask', 'deny', 'inherit']);
const ruleId = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operationKey = z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/\S{0,500}$/);

export const integrationPolicySchema = z.object({
  integrationId: ruleId,
  businessId: z.string().uuid(),
  enabled: z.boolean(),
  manifestHash: hash,
  policyRevision: z.number().int().positive(),
  defaultMode: mode,
  groups: z.array(z.object({
    id: ruleId,
    // MVP groups are an exact OpenAPI tag or an explicit operation list; no wildcards.
    selector: z.union([z.object({ tag: z.string().min(1).max(100) }).strict(), z.object({ operationKeys: z.array(operationKey).min(1).max(200) }).strict()]),
    mode: ruleMode,
  }).strict()).max(100),
  operations: z.array(z.object({
    operationKey,
    enabled: z.boolean(),
    reviewedOperationHash: hash.nullable(),
    mode: ruleMode,
  }).strict()).max(1000),
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.groups.map(group => group.id)).size !== policy.groups.length) ctx.addIssue({ code: 'custom', message: 'Duplicate group id' });
  if (new Set(policy.operations.map(op => op.operationKey)).size !== policy.operations.length) ctx.addIssue({ code: 'custom', message: 'Duplicate operationKey' });
});
export type IntegrationPolicy = z.infer<typeof integrationPolicySchema>;

/** The operation as described by the currently loaded manifest. */
export interface CatalogOperation {
  operationKey: string;
  tags: readonly string[];
  effect: 'read' | 'write' | 'unknown';
  operationHash: string;
}

export interface PermissionRequest {
  businessId: string;
  integrationId: string;
  manifestHash: string;
  operation: CatalogOperation;
}

export interface PermissionDecision {
  mode: PermissionMode;
  source: 'operation' | 'group' | 'integration' | 'guard';
  matchedRuleIds: string[];
  policyRevision: number | null;
  reasonCode: string;
}

const strictness: Record<PermissionMode, number> = { auto: 0, ask: 1, deny: 2 };

export function resolvePermission(request: PermissionRequest, rawPolicy: unknown): PermissionDecision {
  const parsed = integrationPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) return guard('policy_invalid', null);
  const policy = parsed.data;
  const deny = (reasonCode: string) => guard(reasonCode, policy.policyRevision);
  const { operation } = request;
  if (policy.businessId !== request.businessId) return deny('business_mismatch');
  if (policy.integrationId !== request.integrationId) return deny('integration_mismatch');
  if (!policy.enabled) return deny('integration_disabled');
  if (policy.manifestHash !== request.manifestHash) return deny('manifest_mismatch');
  const rule = policy.operations.find(op => op.operationKey === operation.operationKey);
  if (!rule?.enabled) return deny('operation_disabled');
  // A new or changed definition stays unavailable until someone reviews this exact hash, whatever the defaults say.
  if (rule.reviewedOperationHash !== operation.operationHash) return deny('operation_unreviewed');
  if (operation.effect === 'unknown') return deny('effect_unreviewed');

  if (rule.mode !== 'inherit') return { mode: rule.mode, source: 'operation', matchedRuleIds: [operation.operationKey], policyRevision: policy.policyRevision, reasonCode: 'operation_rule' };
  const matched = policy.groups
    .filter(group => group.mode !== 'inherit' && ('tag' in group.selector ? operation.tags.includes(group.selector.tag) : group.selector.operationKeys.includes(operation.operationKey)))
    .map(group => ({ id: group.id, mode: group.mode as PermissionMode }));
  if (matched.length) {
    const strictest = matched.reduce((a, b) => strictness[b.mode] > strictness[a.mode] ? b : a).mode;
    return { mode: strictest, source: 'group', matchedRuleIds: matched.map(group => group.id).sort(), policyRevision: policy.policyRevision, reasonCode: matched.length > 1 ? 'group_conflict_strictest' : 'group_rule' };
  }
  return { mode: policy.defaultMode, source: 'integration', matchedRuleIds: [], policyRevision: policy.policyRevision, reasonCode: 'integration_default' };
}

const guard = (reasonCode: string, policyRevision: number | null): PermissionDecision => ({ mode: 'deny', source: 'guard', matchedRuleIds: [], policyRevision, reasonCode });

/** sha256 over canonical JSON (sorted keys), ignoring formatting and key order; `omit` drops the top-level hash field itself. */
export function fingerprint(value: unknown, omit?: string): string {
  const body = omit && value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== omit)) : value;
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
