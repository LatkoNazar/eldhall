import type { Proposal } from './api'
import { toolLabel } from './api'
import type { AppMessageKey, Translate } from '../i18n'

export const isExternalAction = (proposal: Proposal) => proposal.tool === 'external_action'
export function proposalTitle(proposal: Proposal, t: Translate) { return isExternalAction(proposal) && typeof proposal.args.title === 'string' ? proposal.args.title : toolLabel(proposal.tool, t) }
export function externalInput(proposal: Proposal): Record<string, unknown> {
  const value = proposal.args.input
  return isExternalAction(proposal) && value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function proposalDeadline(proposal: Proposal): number | null {
  if (!isExternalAction(proposal) || typeof proposal.args.expiresAt !== 'string') return null
  const timestamp = Date.parse(proposal.args.expiresAt)
  return Number.isFinite(timestamp) ? timestamp : null
}
export function actionEventLabel(type: string, t: Translate) {
  const labels: Record<string, AppMessageKey> = {
    'action.proposed': 'core.audit.proposed', 'action.denied': 'core.status.denied', 'action.approved': 'core.audit.approved',
    'action.rejected': 'core.audit.rejected', 'action.executed': 'core.audit.executed', 'action.failed': 'core.audit.failed',
    'action.unknown': 'core.audit.unknown', 'action.reconciled': 'core.audit.reconciled',
    'action.expired': 'core.status.expired', 'action.invalidated': 'core.status.invalidated',
  }
  const key = labels[type]
  return key ? t(key) : type
}
