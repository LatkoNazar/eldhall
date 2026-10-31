import type { Business, Customer, Payment, PolicyCheck, PolicyResult, Proposal, Refund } from '../support/contracts.js';
import { TOOLS, isToolName } from './tools.js';

export interface PolicyContext {
  business: Business;
  customer: Customer;
  payments: Payment[];          // loaded server-side for the session customer only
  refunds: Refund[];
  openProposals: Proposal[];    // pending/executing proposals in the case
}

// Deterministic business rules. Inputs are backend state + typed args; sentiment is deliberately absent.
export function evaluatePolicy(tool: string, rawArgs: unknown, ctx: PolicyContext): PolicyResult {
  const checks: PolicyCheck[] = [];
  const check = (name: string, passed: boolean, detail: string) => { checks.push({ name, passed, detail }); return passed; };
  const done = (requiresApproval: boolean): PolicyResult => ({ allowed: checks.every(c => c.passed), requiresApproval, checks });

  if (!check('known_tool', isToolName(tool) && TOOLS[tool].kind === 'write', `Tool "${tool}" is a registered action`)) return done(true);
  check('tool_enabled', ctx.business.policy.enabledTools.includes(tool), `${ctx.business.name} enables ${tool}`);
  const parsed = TOOLS[tool as keyof typeof TOOLS].args.safeParse(rawArgs);
  if (!check('valid_arguments', parsed.success, parsed.success ? 'Arguments match the schema' : 'Arguments do not match the schema')) return done(true);

  if (tool === 'escalate_to_human') return done(false);

  const args = parsed.data as { payment_id: string; amount_cents: number };
  const payment = ctx.payments.find(p => p.id === args.payment_id);
  if (!check('payment_belongs_to_customer', Boolean(payment), payment ? `Payment ${payment.merchantRef} belongs to ${ctx.customer.name}` : 'Payment not found among this customer\'s payments')) return done(true);
  const p = payment!;
  check('business_currency', p.currency === ctx.business.currency, `Payment currency ${p.currency}; business limit currency ${ctx.business.currency}`);
  check('payment_captured', p.status === 'captured', `Payment status is ${p.status}`);
  check('not_already_refunded', !ctx.refunds.some(r => r.paymentId === p.id), 'No refund exists for this payment');
  check('no_open_proposal', !ctx.openProposals.some(o => o.tool === 'refund_payment' && (o.args as { payment_id?: string }).payment_id === p.id), 'No other refund for this payment awaits a decision');
  check('full_amount', args.amount_cents === p.amountCents, `Requested ${money(args.amount_cents, p.currency)}; payment is ${money(p.amountCents, p.currency)}`);
  check('within_refund_limit', p.amountCents <= ctx.business.policy.refundLimitCents, `Limit ${money(ctx.business.policy.refundLimitCents, p.currency)}`);
  const twin = findTwin(p, ctx.payments, ctx.business.policy.duplicateWindowMinutes);
  check('duplicate_detected', Boolean(twin), twin
    ? `Identical charge ${twin.merchantRef} ${Math.round(Math.abs(Date.parse(p.createdAt) - Date.parse(twin.createdAt)) / 1000)} s apart`
    : `No identical charge within ${ctx.business.policy.duplicateWindowMinutes} min`);
  return done(true);
}

export function findTwin(payment: Payment, payments: Payment[], windowMinutes: number): Payment | undefined {
  const targetTime = Date.parse(payment.createdAt);
  if (payment.status !== 'captured' || !Number.isFinite(targetTime)) return undefined;
  return payments.find(other => {
    const otherTime = Date.parse(other.createdAt);
    const earlier = otherTime < targetTime || (otherTime === targetTime && other.id.localeCompare(payment.id) < 0);
    return other.id !== payment.id && other.status === 'captured' && other.currency === payment.currency
      && other.merchantRef === payment.merchantRef && other.amountCents === payment.amountCents
      && Number.isFinite(otherTime) && earlier && targetTime - otherTime <= windowMinutes * 60_000;
  });
}

/** The later charge of the first duplicate pair still captured, if any. */
export function duplicateCandidate(payments: Payment[], windowMinutes: number): Payment | undefined {
  return [...payments].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .find(p => Boolean(findTwin(p, payments, windowMinutes)));
}

export const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;
