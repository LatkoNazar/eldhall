// Product events from docs/ANALYTICS_PLAN.md. Every property is an enum from this allow-list;
// unknown keys or values drop the whole event, so free text, names, ids or amounts cannot leak.
export const productEvents = {
  demo_started: { scenario: ['refund', 'limit'] },
  demo_completed: { scenario: ['refund', 'limit'] },
  support_case_created: {},
  approval_granted: { tool: ['refund_payment', 'escalate_to_human'] },
  action_executed: { tool: ['refund_payment', 'escalate_to_human'] },
  action_failed: { tool: ['refund_payment', 'escalate_to_human'], outcome: ['failed', 'unknown'] },
} as const satisfies Record<string, Record<string, readonly string[]>>
export type ProductEvent = keyof typeof productEvents
export type ProductEventProps<E extends ProductEvent> = { [K in keyof (typeof productEvents)[E]]: (typeof productEvents)[E][K] extends readonly (infer V)[] ? V : never }

/** Returns sanitized event data, or null when anything is outside the allow-list. */
export function validateProductEvent(event: string, props: Record<string, unknown> = {}): Record<string, string> | null {
  if (!Object.hasOwn(productEvents, event)) return null
  const schema = productEvents[event as ProductEvent] as Record<string, readonly string[]>
  const keys = Object.keys(props)
  if (keys.some(key => !Object.hasOwn(schema, key)) || Object.keys(schema).some(key => !keys.includes(key))) return null
  const data: Record<string, string> = {}
  for (const key of keys) {
    const value = props[key]
    if (typeof value !== 'string' || !schema[key]!.includes(value)) return null
    data[key] = value
  }
  return data
}
