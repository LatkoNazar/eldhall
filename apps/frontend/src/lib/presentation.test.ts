import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProposalStatus } from './api'
import { contextText, factText, presentProposal, project, record, relatedPayments, templateFor, templateIds, type TemplateId } from './presentation'
import { translateMessage } from '../i18n'

import { detail, proposal } from '../test/presentation-fixtures'
const time = '2026-11-04T12:00:00.000Z'

it.each([
  ['payments', { paymentId: 'pay-1', amountCents: 12345, currency: 'EUR' }, ['payment_id', 'amount_cents']],
  ['delivery', { shipmentId: 'ship-1', trackingNumber: 'track-1', carrier: 'Carrier' }, ['shipment_id', 'tracking_number', 'carrier']],
  ['orders', { orderId: 'order-1', orderNumber: 'A1', itemCount: 3 }, ['order_id', 'order_number', 'item_count']],
  ['returns', { returnId: 'return-1', orderId: 'order-1', reason: 'Original reason' }, ['return_id', 'order_id', 'reason']],
  ['booking', { bookingId: 'book-1', startsAt: time, guestCount: 2 }, ['booking_id', 'starts_at', 'guest_count']],
  ['appointments', { appointmentId: 'visit-1', serviceName: 'Original service', specialist: 'Original specialist' }, ['appointment_id', 'service_name', 'specialist']],
  ['subscription', { subscriptionId: 'sub-1', planName: 'Original plan', effectiveAt: time }, ['subscription_id', 'plan_name', 'effective_at']],
  ['account', { accountId: 'account-1', contactEmail: 'synthetic@example.test', requestedChange: 'Original request' }, ['account_id', 'contact_email', 'requested_change']],
  ['access', { userId: 'user-1', resourceId: 'resource-1', role: 'reader' }, ['user_id', 'resource_id', 'role']],
  ['incident', { incidentId: 'incident-1', serviceName: 'Original service', severity: 'high' }, ['incident_id', 'service_name', 'severity']],
  ['warranty', { claimId: 'claim-1', productId: 'product-1', serialNumber: 'serial-1' }, ['claim_id', 'product_id', 'serial_number']],
  ['escalation', { ticketId: 'ticket-1', team: 'Original team', priority: 'P2' }, ['ticket_id', 'team', 'priority']],
] as const)('projects reviewed %s fields with exact spelling aliases only', (id, input, fields) => {
  const current = proposal(id, input)
  expect(templateFor(current)).toBe(id)
  const view = presentProposal(current, detail(current))
  expect(view.requested.facts.map(fact => fact.id)).toEqual(fields)
  expect(view.requested.partial).toBe(false)
  expect(view.confirmed.facts).toEqual([])
  expect(view.confirmed.partial).toBe(false)
})

it.each([undefined, null, 'eldhall.ui.orders', [], ['eldhall.ui.unknown'], ['eldhall.ui.orders', 'eldhall.ui.delivery'], ['eldhall.ui.orders', 'eldhall.ui.unknown'], ['eldhall.ui.orders', 7]])('uses the generic view for absent, malformed or ambiguous tags (%j)', tags => {
  const current = proposal('orders', { order_id: 'order-1' })
  current.args.tags = tags
  current.args.title = 'Payments delivery booking'
  expect(templateFor(current)).toBe('generic')
  expect(presentProposal(current, detail(current)).requested.facts).toEqual([])
})

it('does not let arbitrary tool names or titles select a template and accepts duplicate identical reviewed tags', () => {
  const current = proposal('orders')
  current.args.tags = ['orders', 'eldhall.ui.orders', 'eldhall.ui.orders']
  expect(templateFor(current)).toBe('orders')
  expect(templateFor({ ...current, tool: 'delivery_booking_payment' })).toBe('generic')
  expect(templateFor({ ...current, tool: 'refund_payment' })).toBe('payments')
  expect(templateFor({ ...current, tool: 'escalate_to_human' })).toBe('escalation')
})

it('omits conflicting aliases, objects, control characters and unlisted sensitive fields without losing other safe fields', () => {
  const output = project('delivery', { shipment_id: 'one', shipmentId: 'two', tracking_number: { token: 'SECRET' }, carrier: 'Original carrier', delivery_date: '2026-02-30', status: 'bad\nstatus', authorization: 'SECRET', api_key: 'SECRET' })
  expect(output).toEqual({ conflicting: true, partial: true, facts: [{ id: 'carrier', label: 'presentation.field.carrier', kind: 'text', value: 'Original carrier' }] })
  expect(project('orders', { order_id: 'same', orderId: 'same' }).facts).toHaveLength(1)
  expect(project('orders', { order_id: 'x'.repeat(500) }).facts[0]?.value).toHaveLength(181)
  expect(project('orders', { order_id: 'x'.repeat(500) }).partial).toBe(true)
  expect(project('orders', { item_count: 1.5 }).facts).toEqual([])
})

it('marks omitted unknown or invalid source fields without changing the original data', () => {
  const input = Object.freeze({ shipment_id: 'S1', delivery_date: 'tomorrow', new_address: 'Original unmapped address' })
  const view = project('delivery', input)
  expect(view.facts.map(fact => fact.value)).toEqual(['S1'])
  expect(view.partial).toBe(true)
  expect(input).toEqual({ shipment_id: 'S1', delivery_date: 'tomorrow', new_address: 'Original unmapped address' })
  expect(project('delivery', {}).partial).toBe(false)
  expect(project('delivery', undefined).partial).toBe(false)
  expect(project('delivery', [{ shipment_id: 'S1' }]).partial).toBe(true)
  expect(project('delivery', []).partial).toBe(false)
})

it('counts equal aliases and paired currency as represented while exposing invalid or incomplete pairs', () => {
  expect(project('payments', { payment_id: 'P1', paymentId: 'P1', amount_cents: 1234, amountCents: 1234, currency: 'EUR' }).partial).toBe(false)
  expect(project('payments', { amount_cents: 1234 }).partial).toBe(true)
  expect(project('payments', { currency: 'EUR' }).partial).toBe(true)
  expect(project('payments', { amount_cents: 1234, currency: 'INVALID' }).partial).toBe(true)
  expect(project('payments', { amount_cents: 1234, amountCents: 5678, currency: 'EUR' }).partial).toBe(true)
})

it('does not produce unnecessary partial notices for the canonical twelve-domain gallery', () => {
  const gallery: unknown = JSON.parse(readFileSync(resolve(process.cwd(), '../../examples/inspector/scenarios.v1.json'), 'utf8'))
  if (!record(gallery) || !Array.isArray(gallery.scenarios)) throw new Error('Invalid synthetic gallery')
  expect(gallery.scenarios).toHaveLength(13)
  let checked = 0
  for (const scenario of gallery.scenarios) {
    if (!record(scenario)) throw new Error('Invalid synthetic scenario')
    if (scenario.template === 'generic') continue
    const id = templateIds.find(value => value === scenario.template)
    if (!id || !record(scenario.detail) || !Array.isArray(scenario.detail.proposals)) throw new Error('Invalid synthetic domain')
    for (const saved of scenario.detail.proposals) {
      if (!record(saved) || !record(saved.args)) throw new Error('Invalid synthetic action')
      expect(project(id, saved.args.input).partial, id).toBe(false)
      if (saved.status === 'executed' && record(saved.result)) expect(project(id, saved.result.data).partial, id).toBe(false)
    }
    checked++
  }
  expect(checked).toBe(12)
})

it.each(['pending', 'approved', 'executing', 'unknown', 'failed', 'denied', 'rejected', 'expired', 'invalidated'] satisfies ProposalStatus[])('never promotes input or supplied output to a confirmed result in %s', status => {
  const current = { ...proposal('delivery', { status: 'requested-status' }), status, result: { data: { status: 'unconfirmed-status' } } }
  const view = presentProposal(current, detail(current))
  expect(view.requested.facts[0]?.value).toBe('requested-status')
  expect(view.confirmed.facts).toEqual([])
  expect(view.confirmed.partial).toBe(false)
})

it('uses only an executed result.data object, declining arrays and manual reconciliation metadata', () => {
  const current = { ...proposal('delivery', { status: 'requested-status' }), status: 'executed' as const, result: { data: { status: 'recorded-status' } } }
  expect(presentProposal(current, detail(current)).confirmed.facts[0]?.value).toBe('recorded-status')
  expect(presentProposal({ ...current, result: { data: [{ status: 'first-row' }] } }, detail(current)).confirmed.facts).toEqual([])
  expect(presentProposal({ ...current, result: { providerRef: 'manual-reference', reconciliationReason: 'manual verification' } }, detail(current)).confirmed.facts).toEqual([])
})

it('requires a valid same-source currency and safe integer monetary amount', () => {
  const current = { ...proposal('payments', { amount_cents: 1234 }), status: 'executed' as const, result: { data: { currency: 'EUR' } } }
  expect(presentProposal(current, detail(current)).requested.facts).toEqual([])
  expect(presentProposal(current, detail(current)).confirmed.facts).toEqual([])
  for (const value of [{ amount_cents: 1234, currency: 'INVALID' }, { amount_cents: -1, currency: 'EUR' }, { amount_cents: 1.2, currency: 'EUR' }, { amount_cents: 1234, amountCents: 5678, currency: 'EUR' }]) expect(project('payments', value).facts).toEqual([])
  expect(factText(project('payments', { amount_cents: 1234, currency: 'EUR' }).facts[0]!, 'en')).toBe('€12.34')
})

it('binds a native confirmed refund to its recorded refund row and payment instead of copying proposed amounts', () => {
  const current = { ...proposal('payments'), tool: 'refund_payment', args: { payment_id: 'payment-1', amount_cents: 9999 }, status: 'executed' as const, result: { refundId: 'refund-recorded', amountCents: 8888 } }
  const data = { ...detail(current), payments: [{ id: 'payment-1', amountCents: 1234, currency: 'EUR', description: 'Original payment', merchantRef: 'reference-1', status: 'captured', createdAt: time }], refunds: [{ id: 'refund-recorded', paymentId: 'payment-1', amountCents: 345, providerRef: 'provider-recorded', simulated: true, createdAt: time }] }
  const view = presentProposal(current, data)
  expect(view.requested.facts.find(fact => fact.kind === 'money')?.value).toBe(9999)
  expect(view.confirmed.facts.find(fact => fact.kind === 'money')).toMatchObject({ value: 345, currency: 'EUR' })
  expect(presentProposal({ ...current, result: { refundId: 'unmatched-refund' } }, data).confirmed.facts).toEqual([])
})

it('keeps date-only values calendar-only and rejects impossible dates or unzoned timestamps', () => {
  const fact = project('delivery', { delivery_date: '2026-11-04' }).facts[0]!
  expect(factText(fact, 'en')).toBe('Nov 4, 2026')
  expect(project('delivery', { delivery_date: '2026-02-30T12:00:00Z' }).facts).toEqual([])
  expect(project('booking', { starts_at: '2026-11-04T12:00:00' }).facts).toEqual([])
  for (const value of ['', 'tomorrow', 'not-a-date', 'malformed-prefix-with-more-characters', '2026-99-99T12:00:00Z']) expect(project('delivery', { delivery_date: value }).facts).toEqual([])
})

it('shows stored payments only when explicitly referenced by a monetary task and never labels delivery as money', () => {
  const current = proposal('delivery', { shipment_id: 'ship-1', amount_cents: 1234, currency: 'EUR' })
  const row = { id: 'payment-1', amountCents: 1234, currency: 'EUR', description: 'Original payment', merchantRef: 'ref-1', status: 'captured', createdAt: time }
  const data = { ...detail(current), payments: [row] }
  expect(relatedPayments(data)).toEqual([])
  expect(contextText(current, data, (key, values) => translateMessage({ key, values }, 'en'), 'en')).toBe('Requested data: Shipment ID: ship-1')
  const payment = proposal('payments', { payment_id: 'payment-1' })
  expect(relatedPayments({ ...data, proposals: [payment] })).toEqual([row])
})

it.each(['delivery', 'orders', 'booking'] satisfies TemplateId[])('never reads prototype values for %s', id => {
  const inherited = Object.create({ shipment_id: 'inherited', order_id: 'inherited', booking_id: 'inherited' }) as Record<string, unknown>
  expect(project(id, inherited).facts).toEqual([])
})
