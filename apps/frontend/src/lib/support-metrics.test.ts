import { describe, expect, it } from 'vitest'
import type { Metrics } from './api'
import { percent, supportKpis } from './support-metrics'

const base = (patch: Partial<Metrics> = {}): Metrics => ({
  cases: 4, byStatus: { open: 1, awaiting_approval: 0, escalated: 1, resolved: 2 }, byPriority: {},
  proposals: { pending: 0, approved: 0, executing: 0, executed: 2, rejected: 0, failed: 1, denied: 1, unknown: 1 },
  refundsIssuedCents: 49900, agentRuns: 4, fallbackRuns: 0, avgAgentLatencyMs: 12, ...patch,
})

describe('supportKpis', () => {
  it('derives rates and action outcomes from server state', () => {
    const k = supportKpis(base())
    expect(k).toMatchObject({ total: 4, resolved: 2, resolutionRate: 0.5, escalationRate: 0.25, successfulActions: 2, failedActions: 2 })
    expect(percent(k.resolutionRate)).toBe('50%')
  })

  it('reports N/A instead of inventing values', () => {
    const k = supportKpis(base({ cases: 0, byStatus: { open: 0, awaiting_approval: 0, escalated: 0, resolved: 0 } }))
    expect(percent(k.resolutionRate)).toBe('N/A')
    expect(k.avgResolutionMs).toBeNull()
  })

  it('counts approvals and denials as neither success nor failure', () => {
    const k = supportKpis(base({ proposals: { pending: 3, approved: 5, executing: 0, executed: 0, rejected: 2, failed: 0, denied: 4, unknown: 0 } }))
    expect(k.successfulActions).toBe(0)
    expect(k.failedActions).toBe(0)
  })
})
