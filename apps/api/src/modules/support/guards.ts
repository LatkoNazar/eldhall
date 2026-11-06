import { z } from 'zod';
import type { PolicyCheck } from './contracts.js';

const target = z.strictObject({ tool: z.enum(['refund_payment', 'external_action']), integrationId: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/).optional(), operationKey: z.string().min(1).max(510).optional() });
const base = { id: z.uuid(), name: z.string().trim().min(1).max(100), definitionVersion: z.literal(1), enabled: z.boolean(), target, reason: z.string().trim().min(1).max(240) };
export const guardRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, kind: z.literal('deny_action') }),
  z.strictObject({ ...base, kind: z.literal('require_approval') }),
  z.strictObject({ ...base, kind: z.literal('amount_limit'), maxAmountCents: z.number().int().nonnegative().max(100_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }),
]).superRefine((rule, ctx) => {
  if (rule.target.tool === 'refund_payment' && (rule.target.integrationId || rule.target.operationKey)) ctx.addIssue({ code: 'custom', message: 'Integration targets apply only to external actions' });
  if (rule.kind === 'amount_limit' && rule.target.tool !== 'refund_payment') ctx.addIssue({ code: 'custom', message: 'Amount limits support registered refunds only' });
});
export const guardRulesSchema = z.array(guardRuleSchema).max(30).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate guard id');
export type GuardRule = z.infer<typeof guardRuleSchema>;
export interface GuardDefinition { kind: GuardRule['kind']; definitionVersion: 1; title: string; description: string; targetTools: ('refund_payment' | 'external_action')[] }
export const guardDefinitions: GuardDefinition[] = [
  { kind: 'deny_action', definitionVersion: 1, title: 'Deny an action', description: 'Additional server-side denial for the selected registered action.', targetTools: ['refund_payment', 'external_action'] },
  { kind: 'amount_limit', definitionVersion: 1, title: 'Refund amount limit', description: 'Additional refund ceiling in a specified currency; mandatory ownership, duplicate and approval checks still apply.', targetTools: ['refund_payment'] },
  { kind: 'require_approval', definitionVersion: 1, title: 'Require approval', description: 'Raise an automatic external action to explicit approval; never bypass mandatory checks.', targetTools: ['refund_payment', 'external_action'] },
];
export interface GuardConfiguration { version: number; revision: number; rules: GuardRule[]; definitions: GuardDefinition[] }
export function guardPolicyUpdate(current: {guards?:GuardRule[];guardRevision?:number}, next: {guards?:GuardRule[];guardRevision?:number}) {
  if(next.guards===undefined) return current.guards===undefined?{}:{guards:current.guards,guardRevision:current.guardRevision??0};
  const guards=guardRulesSchema.parse(next.guards);const revision=next.guardRevision??current.guardRevision??0;const old=current.guardRevision??0;
  const previous=guardRulesSchema.safeParse(current.guards??[]);
  if(revision<old||(!previous.success||JSON.stringify(guards)!==JSON.stringify(previous.data))&&revision<=old)return null;
  return {guards,guardRevision:revision};
}
export function evaluateGuards(tool: string, args: Record<string, unknown>, rules: unknown, currency?: string) {
  const parsed = guardRulesSchema.safeParse(rules ?? []);
  const checks: PolicyCheck[] = [];
  let requiresApproval = false;
  if (!parsed.success) return { rules:[],allowed: false, requiresApproval: true, checks: [{ name: 'guard_configuration', passed: false, detail: 'Guard configuration is invalid' }] };
  for (const rule of parsed.data) {
    if (!rule.enabled || rule.target.tool !== tool || rule.target.integrationId && rule.target.integrationId !== args.integrationId || rule.target.operationKey && rule.target.operationKey !== args.operationKey) continue;
    const passed = rule.kind === 'deny_action' ? false : rule.kind === 'amount_limit' ? Number.isSafeInteger(args.amount_cents) && Number(args.amount_cents) >= 0 && Number(args.amount_cents) <= rule.maxAmountCents && currency === rule.currency : true;
    if (rule.kind === 'require_approval') requiresApproval = true;
    checks.push({ name: `custom_guard:${rule.id}:${rule.kind}`, passed, detail: rule.reason });
  }
  return { rules:parsed.data,allowed: checks.every(check => check.passed), requiresApproval, checks };
}
