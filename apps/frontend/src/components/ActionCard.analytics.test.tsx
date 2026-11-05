import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import * as analytics from '@eldhall/analytics'
import { ActionCard } from './ActionCard'
import { CustomerChat } from '../pages/CustomerChat'
import type { CaseDetail, Proposal } from '../lib/api'

const time = '2026-11-04T12:00:00.000Z'
const hash = 'b'.repeat(64)
const track = vi.fn()
function proposal(status: Proposal['status'] = 'approved'): Proposal {
  return { id: 'proposal-private', caseId: 'case-private', tool: 'refund_payment', args: { payment_id: 'payment-private', amount_cents: 49900 }, argsHash: hash, status, risk: 'high', policy: { allowed: true, requiresApproval: true, checks: [] }, createdAt: time, decidedAt: null, decidedBy: null, result: null, error: null }
}
function detail(current: Proposal): CaseDetail {
  return { case: { id: 'case-private', customerId: 'customer-private', businessId: 'business-private', customerName: 'Synthetic customer', status: 'awaiting_approval', priority: 'P1', intent: null, analysis: null, createdAt: time, updatedAt: time }, customer: { id: 'customer-private', businessId: 'business-private', name: 'Synthetic customer', email: 'synthetic@example.test', plan: 'Test' }, proposals: [current], payments: [], messages: [], refunds: [], audit: [], runs: [] }
}
function response(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }) }
function mount(current: Proposal, result: unknown, status = 200) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => response(init?.method === 'POST' ? result : detail(current), init?.method === 'POST' ? status : 200))
  vi.stubGlobal('fetch', fetch)
  const onChanged = vi.fn()
  const view = render(<ActionCard proposal={current} detail={detail(current)} token="operator-private" stale={false} onChanged={onChanged} />)
  return { fetch, onChanged, view }
}
beforeEach(() => {
  track.mockReset()
  vi.spyOn(analytics, 'currentAnalytics').mockReturnValue({ enabled: true, track, trackLandingCta() {}, trackSignupCompleted() {} })
  sessionStorage.clear()
})

it('tracks a separate hash-bound approval and execution only after their confirmed outcomes', async () => {
  const user = userEvent.setup()
  const current = proposal('pending')
  const { fetch, view } = mount(current, { proposal: { status: 'approved' } })
  await user.click(screen.getByRole('button', { name: 'Погодити повернення' }))
  expect(track.mock.calls).toEqual([['approval_granted', { tool: 'refund_payment' }]])
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ argsHash: hash })
  current.status = 'approved'
  fetch.mockImplementation(async (_input, init) => response(init?.method === 'POST' ? { proposal: { status: 'executed' } } : detail(current)))
  view.rerender(<ActionCard proposal={current} detail={detail(current)} token="operator-private" stale={false} onChanged={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(track.mock.calls).toEqual([['approval_granted', { tool: 'refund_payment' }], ['action_executed', { tool: 'refund_payment' }]])
  expect(screen.getByRole('button', { name: 'Виконати погоджену дію' })).toBeDisabled()
})

it.each(['failed', 'unknown'] as const)('tracks the confirmed %s outcome from a 502 without enabling a retry', async status => {
  mount(proposal(), { proposal: { status, error: 'Provider result requires review' } }, 502)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(track.mock.calls).toEqual([['action_failed', { tool: 'refund_payment', outcome: status }]])
  expect(screen.getByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
})

it.each([409, 403])('does not count a %s conflict or denial even if its body contains a terminal status', async status => {
  mount(proposal(), { detail: 'Request refused', proposal: { status: 'failed' } }, status)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(track).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('Request refused')
})

it('does not turn a transport error into a confirmed failed action', async () => {
  const current = proposal()
  const { fetch } = mount(current, {})
  fetch.mockImplementation(async (_input, init) => { if (init?.method === 'POST') throw new Error('network unavailable'); return response(detail(current)) })
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(track).not.toHaveBeenCalled()
  expect(screen.getByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
})

it('does not send external operation identities through the builtin event contract', async () => {
  const current = { ...proposal(), tool: 'external_action', args: { integrationId: 'private-integration', operationKey: 'POST /private-target', input: {} } }
  mount(current, { proposal: { status: 'executed' } })
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(track).not.toHaveBeenCalled()
})

it.each([200, 502])('a throwing tracker cannot change the confirmed success or error flow (%s)', async status => {
  track.mockImplementation(() => { throw new Error('collector unavailable') })
  const { onChanged } = mount(proposal(), { proposal: { status: status === 200 ? 'executed' : 'unknown', error: 'Provider result requires review' } }, status)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(onChanged).toHaveBeenCalledOnce()
  expect(screen.queryByText('collector unavailable')).not.toBeInTheDocument()
  if (status === 200) {
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText(/Сервер підтвердив завершення запиту/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Виконати погоджену дію' })).toBeDisabled()
  } else {
    expect(screen.getByRole('alert')).toHaveTextContent('Provider result requires review')
    expect(screen.getByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
  }
})

it('a throwing tracker cannot turn a created customer case into an error or expose its session', async () => {
  track.mockImplementation(() => { throw new Error('collector unavailable') })
  const fetch = vi.fn(async (input: RequestInfo | URL) => response(String(input).endsWith('/personas') ? [{ name: 'Synthetic customer', sessionToken: 'customer-private', businessName: 'Demo', plan: 'Test' }] : String(input).endsWith('/chat/cases') ? { id: 'case-private' } : { id: 'case-private', status: 'open', businessName: 'Demo', messages: [] }))
  vi.stubGlobal('fetch', fetch)
  render(<CustomerChat />)
  await userEvent.setup().click(await screen.findByRole('button', { name: /Synthetic customer/ }))
  expect(await screen.findByLabelText('Ваше повідомлення')).toBeInTheDocument()
  expect(screen.queryByText('collector unavailable')).not.toBeInTheDocument()
  expect(track.mock.calls).toEqual([['support_case_created', {}]])
  const create = fetch.mock.calls.find(([url]) => String(url).endsWith('/chat/cases'))
  expect(create).toBeDefined()
})
