import type { Proposal } from './api'
import { toolLabels } from './api'

export const isExternalAction = (proposal: Proposal) => proposal.tool === 'external_action'
export function proposalTitle(proposal: Proposal) { return isExternalAction(proposal) && typeof proposal.args.title === 'string' ? proposal.args.title : toolLabels[proposal.tool] ?? proposal.tool }
export function externalInput(proposal: Proposal): Record<string, unknown> {
  const value = proposal.args.input
  return isExternalAction(proposal) && value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function proposalDeadline(proposal: Proposal): number | null {
  if (!isExternalAction(proposal) || typeof proposal.args.expiresAt !== 'string') return null
  const timestamp = Date.parse(proposal.args.expiresAt)
  return Number.isFinite(timestamp) ? timestamp : null
}
export function actionEventLabel(type: string) {
  const labels: Record<string, string> = {
    'action.proposed': 'Дію запропоновано', 'action.denied': 'Дію не дозволено', 'action.approved': 'Дію погоджено',
    'action.rejected': 'Погодження відхилено', 'action.executed': 'Дію виконано', 'action.failed': 'Дію не виконано',
    'action.unknown': 'Результат потребує звірки', 'action.reconciled': 'Результат звірено оператором',
    'action.expired': 'Строк погодження минув', 'action.invalidated': 'Погодження втратило чинність',
  }
  return labels[type] ?? type
}
