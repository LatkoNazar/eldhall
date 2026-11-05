import { render, screen, waitFor, within } from '../test/render'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CaseDetail, Proposal, ProposalStatus } from '../lib/api'
import { Actions } from './Actions'

const time = '2026-10-31T12:00:00.000Z'
const hash = 'a'.repeat(64)
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function proposal(id: string, status: ProposalStatus): Proposal { return { id, caseId: 'case-1', tool: 'refund_payment', args: { payment_id: 'payment-1', amount_cents: 49900 }, argsHash: hash, risk: 'high', status, policy: { allowed: true, requiresApproval: true, checks: [{ name: 'Власник', passed: true, detail: 'Платіж належить цьому клієнту' }] }, createdAt: time, decidedAt: null, decidedBy: null, result: null, error: null } }
function detail(id: string, name: string, proposals: Proposal[]): CaseDetail { return {
  case: { id, businessId: 'business-1', customerId: `customer-${id}`, customerName: name, status: 'open', priority: 'P2', intent: null, analysis: null, createdAt: time, updatedAt: time },
  customer: { id: `customer-${id}`, businessId: 'business-1', name, email: 'synthetic@example.test', plan: 'Monthly' },
  proposals: proposals.map(item => ({ ...item, caseId: id })), messages: [], runs: [], refunds: [],
  payments: [{ id: 'payment-1', amountCents: 49900, currency: 'UAH', merchantRef: 'SIM-1', description: 'Синтетичний платіж', status: 'captured', createdAt: time }],
  audit: proposals.map(item => ({ id: `audit-${item.id}`, caseId: id, type: 'action.proposed', actor: 'agent', data: { proposalId: item.id }, createdAt: time })),
} }
function props(details: CaseDetail[]) { return { token: 'test-token', cases: details.map(item => item.case), casesError: '', metrics: null, metricsError: '', search: '', onRefresh: vi.fn() } }

describe('AI action table', () => {
  it('counts and renders actual proposals, excluding cases without actions and grouping approved work with pending', async () => {
    const details = [detail('case-1', 'Олена', [proposal('pending-1', 'pending'), proposal('approved-1', 'approved'), proposal('running-1', 'executing'), proposal('done-1', 'executed')]), detail('empty-1', 'Клієнт без дій', [])]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => response(details.find(item => String(input) === `/api/v1/cases/${item.case.id}`))))
    render(<Actions {...props(details)} />)
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).queryByText('Клієнт без дій')).not.toBeInTheDocument()
    expect(within(table).getByText('Очікує погодження')).toBeInTheDocument()
    expect(within(table).getByText('Погоджено, очікує виконання')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Очікують 2' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Виконуються 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Історія 1' })).toBeInTheDocument()
    expect(within(table).queryByText('Виконано')).not.toBeInTheDocument()
  })

  it('opens the selected history proposal and its own audit rather than an unrelated case or action', async () => {
    const first = detail('case-1', 'Олена', [proposal('pending-1', 'pending'), proposal('running-1', 'executing')])
    const second = detail('case-2', 'Тарас', [proposal('done-2', 'executed'), proposal('unknown-2', 'unknown')])
    second.audit = [{ id: 'event-done', type: 'action.executed', actor: 'operator:staff', data: { proposalId: 'done-2' }, createdAt: time }, { id: 'event-unrelated', type: 'action.rejected', actor: 'operator:other', data: { proposalId: 'other-proposal' }, createdAt: time }]
    const details = [first, second]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => response(details.find(item => String(input) === `/api/v1/cases/${item.case.id}`))))
    const user = userEvent.setup()
    render(<Actions {...props(details)} />)
    await user.click(await screen.findByRole('button', { name: 'Виконуються 1' }))
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
    expect(within(screen.getByRole('table')).getByText('Виконується')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Історія 2' }))
    await user.click(screen.getByRole('button', { name: /Відкрити дію.*для Тарас, done-2/ }))
    const inspector = screen.getByRole('complementary', { name: 'Деталі обраної дії' })
    expect(await within(inspector).findByRole('heading', { name: 'Тарас' })).toBeInTheDocument()
    expect(within(inspector).getByText('Дію виконано')).toBeInTheDocument()
    expect(within(inspector).queryByText('Погодження відхилено')).not.toBeInTheDocument()
    expect(within(inspector).queryByRole('button', { name: 'Погодити повернення' })).not.toBeInTheDocument()
    expect(within(inspector).getByText('Повернення виконано симульованим провайдером.')).toBeInTheDocument()
  })

  it('retains stale proposals and disables their controls after a detail refresh fails', async () => {
    const current = detail('case-1', 'Олена', [proposal('pending-1', 'pending')])
    let unavailable = false
    vi.stubGlobal('fetch', vi.fn(async () => unavailable ? response({ detail: 'Сховище тимчасово недоступне' }, 503) : response(current)))
    const user = userEvent.setup()
    render(<Actions {...props([current])} />)
    const approve = await screen.findByRole('button', { name: 'Погодити повернення' })
    await waitFor(() => expect(approve).toBeEnabled())
    unavailable = true
    await user.click(screen.getByRole('button', { name: 'Оновити' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Частина дій може бути відсутня або застаріла')
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Погодити повернення' })).toBeDisabled()
    expect(screen.getByText('Високий ризик · застарілі дані')).toBeInTheDocument()
  })

  it('returns keyboard focus to the selected proposal row after closing its inspector', async () => {
    const current = detail('case-1', 'Олена', [proposal('pending-1', 'pending')])
    vi.stubGlobal('fetch', vi.fn(async () => response(current)))
    const user = userEvent.setup()
    render(<Actions {...props([current])} />)
    const rowButton = await screen.findByRole('button', { name: /Відкрити дію.*pending-1/ })
    await user.click(rowButton)
    await user.click(screen.getByRole('button', { name: 'Закрити деталі дії' }))
    await waitFor(() => expect(rowButton).toHaveFocus())
    expect(screen.queryByRole('complementary', { name: 'Деталі обраної дії' })).not.toBeInTheDocument()
  })

  it('keeps shared hash-bound approval separate from execution inside the inspector', async () => {
    let current = detail('case-1', 'Олена', [proposal('pending-1', 'pending')])
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/approve') && init?.method === 'POST') current = { ...current, proposals: current.proposals.map(item => ({ ...item, status: 'approved' })) }
      if (path.endsWith('/execute') && init?.method === 'POST') current = { ...current, proposals: current.proposals.map(item => ({ ...item, status: 'executed' })) }
      return response(path.endsWith('/approve') || path.endsWith('/execute') ? { case: current.case, proposal: current.proposals[0] } : current)
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<Actions {...props([current])} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Погодити повернення' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Погодити повернення' }))
    const execute = await screen.findByRole('button', { name: 'Виконати погоджену дію' })
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/execute'))).toBe(false)
    const approval = fetch.mock.calls.find(([path]) => String(path).endsWith('/approve'))
    expect(JSON.parse(String(approval?.[1]?.body))).toEqual({ argsHash: hash })
    await user.click(execute)
    expect(await screen.findByText('Повернення виконано симульованим провайдером.')).toBeInTheDocument()
    expect(screen.getByText(/Дія перейшла у вкладку/)).toHaveTextContent('Історія')
  })
})
