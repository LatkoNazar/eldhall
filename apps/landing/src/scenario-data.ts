// Illustrative scenarios only: the page makes no business API or model calls.
import { formatMoney, formatNumber, type Locale } from '../../../packages/i18n/src/core.ts'
import { translate } from './i18n/index.ts'

export type ScenarioId = 'refund' | 'limit'
export type ChatRole = 'customer' | 'assistant'
export interface ChatMessage { role: ChatRole; text: string }
export interface Check { label: string; detail: string; passed: boolean }
export interface Fact { term: string; value: string }
export type Tone = 'accent' | 'warn' | 'info' | 'ok' | 'grey'
export interface Tag { label: string; tone: Tone }
export interface Step { label: string; kicker: string; title: string; text: string; chat?: ChatMessage[]; typing?: boolean; tags?: Tag[]; facts?: Fact[]; checks?: Check[] }
export interface Scenario { id: ScenarioId; business: string; steps: Step[] }

export function getScenarios(locale: Locale): Record<ScenarioId, Scenario> {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate(locale, key, values)
  const amount = formatMoney(49900, 'UAH', locale)
  const annual = formatMoney(399900, 'UAH', locale)
  const limit = formatMoney(200000, 'UAH', locale)
  const reference = 'SUB-OCT-2026'
  const seconds = (number: number) => t('fact.seconds', { number: formatNumber(number, locale) })
  const owner: Check = { label: t('check.owner'), detail: t('check.ownerText'), passed: true }
  const duplicate = (number: number): Check => ({ label: t('check.duplicate'), detail: t('check.duplicateText', { number: formatNumber(number, locale) }), passed: true })
  return {
    refund: { id: 'refund', business: 'NovaPay Fitness', steps: [
      { label: t('step.request'), kicker: t('kicker.request'), title: t('refund.request.title'), text: t('refund.request.text'),
        chat: [{ role: 'customer', text: t('refund.request.chat') }],
        facts: [{ term: t('fact.customer'), value: t('fact.demo', { name: 'Olena K.' }) }, { term: t('fact.plan'), value: t('fact.premium') }, { term: t('fact.channel'), value: t('fact.chat') }] },
      { label: t('step.analysis'), kicker: t('kicker.analysis'), title: t('refund.analysis.title'), text: t('refund.analysis.text'), typing: true,
        tags: [{ label: 'duplicate_charge', tone: 'info' }, { label: t('tag.frustrated'), tone: 'warn' }, { label: t('tag.urgency'), tone: 'warn' }, { label: 'P1', tone: 'accent' }],
        facts: [{ term: t('fact.found'), value: `${formatNumber(2, locale)} × ${amount} · ${reference}` }, { term: t('fact.difference'), value: seconds(40) }, { term: t('fact.tools'), value: 'lookup_payments → submit_decision' }] },
      { label: t('step.policy'), kicker: t('kicker.policy'), title: t('refund.policy.title'), text: t('refund.policy.text'),
        chat: [{ role: 'assistant', text: t('refund.policy.chat', { amount }) }],
        checks: [owner, duplicate(40), { label: t('check.unrefunded'), detail: t('check.unrefundedText'), passed: true }, { label: t('check.limit'), detail: t('check.within', { amount, limit }), passed: true }] },
      { label: t('step.decision'), kicker: t('kicker.approval'), title: t('refund.approval.title'), text: t('refund.approval.text'),
        tags: [{ label: 'refund_payment', tone: 'grey' }, { label: t('tag.high'), tone: 'accent' }, { label: t('tag.approved'), tone: 'ok' }],
        facts: [{ term: t('fact.action'), value: 'refund_payment' }, { term: t('fact.amount'), value: amount }, { term: t('fact.payment'), value: t('fact.secondCharge', { reference }) }, { term: t('fact.decision'), value: t('fact.operator') }, { term: t('fact.approvalEffect'), value: t('fact.zero') }, { term: t('fact.next'), value: t('fact.separate') }] },
      { label: t('step.execute'), kicker: t('kicker.execute'), title: t('refund.execute.title'), text: t('refund.execute.text'),
        chat: [{ role: 'assistant', text: t('refund.execute.chat', { amount, reference }) }],
        tags: [{ label: t('tag.refunded'), tone: 'ok' }, { label: t('tag.resolved'), tone: 'ok' }, { label: t('tag.simulated'), tone: 'grey' }],
        facts: [{ term: t('fact.execution'), value: t('fact.executeOperator') }, { term: t('fact.audit'), value: 'received → analyzed → proposed → approved → executed' }, { term: t('fact.repeat'), value: t('fact.conflict') }] },
    ] },
    limit: { id: 'limit', business: 'NovaPay Fitness', steps: [
      { label: t('step.request'), kicker: t('kicker.request'), title: t('limit.request.title'), text: t('limit.request.text'),
        chat: [{ role: 'customer', text: t('limit.request.chat') }],
        facts: [{ term: t('fact.customer'), value: t('fact.demo', { name: 'Ivan B.' }) }, { term: t('fact.plan'), value: t('fact.annual') }] },
      { label: t('step.analysis'), kicker: t('kicker.analysis'), title: t('limit.analysis.title'), text: t('limit.analysis.text'), typing: true,
        tags: [{ label: 'duplicate_charge', tone: 'info' }, { label: t('tag.abusive'), tone: 'accent' }, { label: t('tag.tone'), tone: 'warn' }, { label: 'P1', tone: 'accent' }],
        facts: [{ term: t('fact.found'), value: `${formatNumber(2, locale)} × ${annual} · SUB-ANNUAL-2026` }, { term: t('fact.signals'), value: t('fact.signalText') }] },
      { label: t('step.policy'), kicker: t('kicker.policy'), title: t('limit.policy.title'), text: t('limit.policy.text'),
        checks: [owner, duplicate(70), { label: t('check.limit'), detail: t('check.over', { amount: annual, limit }), passed: false }] },
      { label: t('step.decision'), kicker: t('kicker.escalation'), title: t('limit.decision.title'), text: t('limit.decision.text'),
        chat: [{ role: 'assistant', text: t('limit.decision.chat') }],
        tags: [{ label: `refund_payment: ${t('tag.denied')}`, tone: 'accent' }, { label: `escalate_to_human: ${t('tag.executed')}`, tone: 'ok' }] },
      { label: t('step.result'), kicker: t('kicker.result'), title: t('limit.result.title'), text: t('limit.result.text'),
        tags: [{ label: t('tag.escalated'), tone: 'warn' }, { label: 'refund: none', tone: 'grey' }],
        facts: [{ term: t('fact.audit'), value: 'received → analyzed → denied → escalated' }] },
    ] },
  }
}

export const SCENARIOS = getScenarios('en')
