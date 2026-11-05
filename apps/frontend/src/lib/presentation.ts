import type { CaseDetail, Proposal } from './api'
import type { AppMessageKey, Locale, Translate } from '../i18n'
import { formatDateTime, formatMoney, formatNumber, localeOptions } from '../../../../packages/i18n/src/core.ts'

export const templateIds = ['payments', 'delivery', 'orders', 'returns', 'booking', 'appointments', 'subscription', 'account', 'access', 'incident', 'warranty', 'escalation'] as const
export type TemplateId = typeof templateIds[number]
export type PresentationId = TemplateId | 'generic'
type FieldId = 'payment_id' | 'transaction_id' | 'amount_cents' | 'status' | 'shipment_id' | 'tracking_number' | 'carrier' | 'delivery_date' | 'order_id' | 'order_number' | 'item_count' | 'return_id' | 'reason' | 'booking_id' | 'starts_at' | 'ends_at' | 'guest_count' | 'appointment_id' | 'service_name' | 'specialist' | 'subscription_id' | 'plan_name' | 'effective_at' | 'account_id' | 'contact_email' | 'requested_change' | 'user_id' | 'resource_id' | 'role' | 'expires_at' | 'incident_id' | 'severity' | 'impact' | 'claim_id' | 'product_id' | 'serial_number' | 'issue' | 'ticket_id' | 'team' | 'priority'
type Kind = 'text' | 'number' | 'date' | 'money'
interface Field { id: string; aliases: readonly string[]; kind: Kind; label: AppMessageKey }
export interface Fact { id: string; label: AppMessageKey; kind: Kind; value: string | number; currency?: string }
export interface Projection { facts: Fact[]; conflicting: boolean; partial: boolean }
const field = (id: FieldId, kind: Kind = 'text'): Field => ({ id, kind, aliases: [id, id.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())], label: `presentation.field.${id}` })
export const presentationRegistry = {
  payments: [field('payment_id'), field('transaction_id'), field('amount_cents', 'money'), field('status')],
  delivery: [field('shipment_id'), field('tracking_number'), field('carrier'), field('delivery_date', 'date'), field('status')],
  orders: [field('order_id'), field('order_number'), field('item_count', 'number'), field('status')],
  returns: [field('return_id'), field('order_id'), field('reason'), field('status')],
  booking: [field('booking_id'), field('starts_at', 'date'), field('ends_at', 'date'), field('guest_count', 'number'), field('status')],
  appointments: [field('appointment_id'), field('service_name'), field('starts_at', 'date'), field('specialist'), field('status')],
  subscription: [field('subscription_id'), field('plan_name'), field('effective_at', 'date'), field('status')],
  account: [field('account_id'), field('contact_email'), field('requested_change'), field('status')],
  access: [field('user_id'), field('resource_id'), field('role'), field('expires_at', 'date'), field('status')],
  incident: [field('incident_id'), field('service_name'), field('severity'), field('impact'), field('status')],
  warranty: [field('claim_id'), field('product_id'), field('serial_number'), field('issue'), field('status')],
  escalation: [field('ticket_id'), field('team'), field('reason'), field('priority'), field('status')],
} satisfies Record<TemplateId, readonly Field[]>

export function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function templateFor(proposal: Proposal): PresentationId {
  if (proposal.tool === 'refund_payment') return 'payments'
  if (proposal.tool === 'escalate_to_human') return 'escalation'
  if (proposal.tool !== 'external_action' || !Array.isArray(proposal.args.tags) || proposal.args.tags.length > 100 || proposal.args.tags.some(tag => typeof tag !== 'string')) return 'generic'
  const selected = [...new Set<string>(proposal.args.tags.filter((tag: string) => tag.startsWith('eldhall.ui.')))]
  if (selected.length !== 1) return 'generic'
  const id = selected[0]!.slice('eldhall.ui.'.length)
  return templateIds.find(known => known === id) ?? 'generic'
}
function own(source: Record<string, unknown>, key: string) { return Object.hasOwn(source, key) ? source[key] : undefined }
function read(source: Record<string, unknown>, aliases: readonly string[]) {
  const values = [...new Set(aliases)].filter(key => Object.hasOwn(source, key)).map(key => own(source, key))
  return { value: values[0], conflict: values.length > 1 && values.some(value => !Object.is(value, values[0])) }
}
export function validCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf('currency').includes(value)
}
function calendarDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return calendarDate(value)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && calendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
}
export function project(id: PresentationId, value: unknown): Projection {
  const nonempty = record(value) ? Object.keys(value).length > 0 : Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== ''
  if (id === 'generic' || !record(value)) return { facts: [], conflicting: false, partial: nonempty }
  const facts: Fact[] = []
  const represented = new Set<string>()
  let conflicting = false
  let shortened = false
  for (const spec of presentationRegistry[id]) {
    const before = facts.length
    const item = read(value, spec.aliases)
    if (item.conflict) { conflicting = true; continue }
    if (spec.kind === 'money') {
      const currency = own(value, 'currency')
      if (typeof item.value === 'number' && Number.isSafeInteger(item.value) && item.value >= 0 && validCurrency(currency)) facts.push({ id: spec.id, label: spec.label, kind: 'money', value: item.value, currency })
    } else if (spec.kind === 'number') {
      if (typeof item.value === 'number' && Number.isSafeInteger(item.value) && item.value >= 0) facts.push({ id: spec.id, label: spec.label, kind: 'number', value: item.value })
    } else if (spec.kind === 'date') {
      if (validDate(item.value)) facts.push({ id: spec.id, label: spec.label, kind: 'date', value: item.value })
    } else if (typeof item.value === 'string' && item.value.trim() && !/\p{Cc}/u.test(item.value)) {
      facts.push({ id: spec.id, label: spec.label, kind: 'text', value: item.value.length > 180 ? `${item.value.slice(0, 180)}…` : item.value })
      shortened ||= item.value.length > 180
    }
    if (facts.length > before) {
      for (const alias of spec.aliases) if (Object.hasOwn(value, alias)) represented.add(alias)
      if (spec.kind === 'money') represented.add('currency')
    }
  }
  return { facts, conflicting, partial: shortened || Object.keys(value).some(key => !represented.has(key)) }
}
export function presentProposal(proposal: Proposal, detail: CaseDetail) {
  const id = templateFor(proposal)
  const payment = proposal.tool === 'refund_payment' ? detail.payments.find(item => item.id === proposal.args.payment_id) : undefined
  const requested = proposal.tool === 'external_action' ? proposal.args.input : proposal.tool === 'refund_payment' ? { ...proposal.args, ...(payment ? { currency: payment.currency } : {}) } : proposal.args
  let confirmed: unknown
  if (proposal.status === 'executed') {
    if (proposal.tool === 'external_action') confirmed = proposal.result?.data
    else if (proposal.tool === 'refund_payment') {
      const refund = detail.refunds.find(item => item.id === proposal.result?.refundId)
      const actualPayment = refund && detail.payments.find(item => item.id === refund.paymentId)
      if (refund && actualPayment) confirmed = { payment_id: refund.paymentId, amount_cents: refund.amountCents, currency: actualPayment.currency }
    }
  }
  return { id, requested: project(id, requested), confirmed: project(id, confirmed) }
}
export function factText(fact: Fact, locale: Locale): string {
  if (fact.kind === 'money' && fact.currency) return formatMoney(Number(fact.value), fact.currency, locale)
  if (fact.kind === 'number') return formatNumber(Number(fact.value), locale)
  if (fact.kind === 'date') {
    const value = String(fact.value)
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Intl.DateTimeFormat(localeOptions.find(option => option.code === locale)!.intlLocale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
    return formatDateTime(value, locale)
  }
  return String(fact.value)
}
export function contextText(proposal: Proposal, detail: CaseDetail, t: Translate, locale: Locale) {
  const view = presentProposal(proposal, detail)
  const confirmed = proposal.status === 'executed' && view.confirmed.facts.length > 0
  const facts = confirmed ? view.confirmed.facts : view.requested.facts
  const money = facts.find(fact => fact.kind === 'money')
  const ordered = money ? [money, ...facts.filter(fact => fact !== money)] : facts
  const primary = ordered.slice(0, 2).map(fact => `${t(fact.label)}: ${factText(fact, locale)}`).join(' · ')
  return primary ? `${t(confirmed ? 'presentation.confirmed' : 'presentation.requested')}: ${primary}` : t(`presentation.template.${view.id}`)
}
export function relatedPayments(detail: CaseDetail) {
  const ids = new Set(detail.proposals.filter(proposal => templateFor(proposal) === 'payments').flatMap(proposal => {
    const input = proposal.tool === 'external_action' ? proposal.args.input : proposal.args
    if (!record(input)) return []
    const id = read(input, ['payment_id', 'paymentId'])
    return !id.conflict && typeof id.value === 'string' ? [id.value] : []
  }))
  return detail.payments.filter(payment => ids.has(payment.id))
}
