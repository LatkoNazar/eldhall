import { z } from 'zod';
import type { Risk } from '../support/contracts.js';

// Explicit tool registry. Read tools run inside the model loop, scoped to the session customer.
// Write tools are never executed by the model: they become proposals that policy + human approval gate.
export interface ToolDefinition { name: string; description: string; kind: 'read' | 'write'; risk: Risk; args: z.ZodObject }

export const TOOLS = {
  lookup_payments: {
    name: 'lookup_payments', kind: 'read', risk: 'low',
    description: "List the current customer's recent payments (id, amount, merchant reference, status, time). Takes no customer id: the backend scopes it to the authenticated customer.",
    args: z.object({ limit: z.number().int().min(1).max(20).default(10) }),
  },
  refund_payment: {
    name: 'refund_payment', kind: 'write', risk: 'high',
    description: 'Propose refunding one specific payment (full amount). Requires policy validation and human approval.',
    args: z.strictObject({ payment_id: z.string().min(1).max(64), amount_cents: z.number().int().positive() }),
  },
  escalate_to_human: {
    name: 'escalate_to_human', kind: 'write', risk: 'low',
    description: 'Hand the conversation to a human specialist (no money moves). Use for unsupported requests, abusive conversations or when unsure.',
    args: z.strictObject({ reason: z.string().min(3).max(300) }),
  },
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOLS;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(TOOLS, name);
export const WRITE_TOOLS = Object.values(TOOLS).filter(t => t.kind === 'write').map(t => t.name);
