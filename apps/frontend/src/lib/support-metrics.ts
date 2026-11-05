import type { Metrics } from './api'

// Support KPIs derived only from server-confirmed state in GET /metrics. Counts are per case /
// per proposal state, so repeated HTTP requests (e.g. a second Execute → 409) cannot inflate them.
// Values the server does not provide are null and must render as "N/A", never as an estimate.
export interface SupportKpis {
  total: number
  resolved: number
  resolutionRate: number | null
  escalationRate: number | null
  successfulActions: number
  failedActions: number
  unknownActions: number
  avgResolutionMs: null // not exposed by the API yet
}

export function supportKpis(m: Metrics): SupportKpis {
  const rate = (n: number) => (m.cases > 0 ? n / m.cases : null)
  return {
    total: m.cases,
    resolved: m.byStatus.resolved,
    resolutionRate: rate(m.byStatus.resolved),
    escalationRate: rate(m.byStatus.escalated),
    successfulActions: m.proposals.executed ?? 0,
    failedActions: m.proposals.failed ?? 0,
    unknownActions: m.proposals.unknown ?? 0,
    avgResolutionMs: null,
  }
}

export const percent = (value: number | null) => (value == null ? 'N/A' : `${Math.round(value * 100)}%`)
