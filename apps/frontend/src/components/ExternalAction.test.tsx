import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { ActionCard } from './ActionCard'
import type { CaseDetail, Proposal } from '../lib/api'

const hash = 'a'.repeat(64)
const time = '2026-11-04T12:00:00.000Z'
function proposal(status: Proposal['status'] = 'pending'): Proposal { return { id: 'external-1', caseId: 'case-1', tool: 'external_action', args: { integrationId: 'orders', operationKey: 'POST /orders/{order_id}/cancel', title: 'Скасувати замовлення', toolName: 'cancelOrder', input: { order_id: 'order-7', expected_version: 3 }, effect: 'write', policyRevision: 7, connectionRevision: 'conn-3', manifestHash: 'b'.repeat(64), operationHash: 'c'.repeat(64), expiresAt: '2099-01-01T12:00:00.000Z' }, argsHash: hash, risk: 'high', status, policy: { allowed: true, requiresApproval: true, checks: [{ name: 'ownership', passed: true, detail: 'Замовлення належить клієнту' }] }, authorizationOrigin: 'operator_approval', decidedBy: null, decidedAt: null, result: null, error: null, createdAt: time } }
function detail(current: Proposal): CaseDetail { return { case: { id: 'case-1', businessId: 'business-1', customerId: 'customer-1', customerName: 'Олена', status: 'awaiting_approval', priority: 'P2', intent: null, analysis: null, createdAt: time, updatedAt: time }, customer: { id: 'customer-1', businessId: 'business-1', name: 'Олена', email: 'synthetic@example.test', plan: 'Test' }, messages: [], proposals: [current], payments: [], refunds: [], audit: [], runs: [] } }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }

it('shows external identity, target, input, expiry and origin and preserves separate hash-bound approval and execution', async () => {
  let current = proposal()
  const onChanged = vi.fn()
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/approve') && init?.method === 'POST') { current = { ...current, status: 'approved', decidedBy: 'operator:staff' }; return response({ proposal: current, case: detail(current).case }) }
    if (String(input).endsWith('/execute') && init?.method === 'POST') return response({ proposal: { ...current, status: 'executed' }, case: detail(current).case })
    return response(detail(current))
  })
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  const view = render(<ActionCard proposal={current} detail={detail(current)} token="operator" stale={false} onChanged={onChanged} />)
  expect(screen.getByRole('heading', { name: 'Скасувати замовлення' })).toBeInTheDocument()
  expect(screen.getByText('POST /orders/{order_id}/cancel')).toBeInTheDocument()
  expect(screen.getByText('Погодження оператора')).toBeInTheDocument()
  expect(screen.getByText('Строк погодження')).toBeInTheDocument()
  await user.click(screen.getByText('Точні аргументи дії'))
  expect(within(screen.getByText('Точні аргументи дії').closest('details')!).getByText(/"order_id": "order-7"/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Погодити дію' }))
  expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/execute'))).toBe(false)
  const approval = fetch.mock.calls.find(([path]) => String(path).endsWith('/approve'))!
  expect(JSON.parse(String(approval[1]?.body))).toEqual({ argsHash: hash })
  view.rerender(<ActionCard proposal={current} detail={detail(current)} token="operator" stale={false} onChanged={onChanged} />)
  await user.click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  const execute = fetch.mock.calls.find(([path]) => String(path).endsWith('/execute'))!
  expect(JSON.parse(String(execute[1]?.body))).toEqual({ argsHash: hash })
})

it('blocks expired approvals without sending an execution request', () => {
  const current = proposal('approved')
  current.args.expiresAt = '2020-01-01T00:00:00.000Z'
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render(<ActionCard proposal={current} detail={detail(current)} token="operator" stale={false} onChanged={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Виконати погоджену дію' })).toBeDisabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Строк погодження минув')
  expect(fetch).not.toHaveBeenCalled()
})

it('records an unknown outcome only after manual verification and never retries execution', async () => {
  const current = proposal('unknown')
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => response(String(input).endsWith('/reconcile') && init?.method === 'POST' ? { proposal: { ...current, status: 'executed' }, case: detail(current).case } : detail(current)))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<ActionCard proposal={current} detail={detail(current)} token="operator" stale={false} onChanged={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Записати результат звірки' })).toBeDisabled()
  await user.type(screen.getByLabelText('Підстава звірки'), 'Перевірено журнал замовлення у провайдера')
  await user.type(screen.getByLabelText('Ідентифікатор у провайдера (необов’язково)'), 'provider-7')
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Записати результат звірки' }))
  expect(await screen.findByText('Підтверджений результат звірки записано.')).toBeInTheDocument()
  const reconciliation = fetch.mock.calls.find(([path]) => String(path).endsWith('/reconcile'))!
  expect(JSON.parse(String(reconciliation[1]?.body))).toEqual({ status: 'executed', reason: 'Перевірено журнал замовлення у провайдера', providerRef: 'provider-7' })
  expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/execute'))).toBe(false)
})

it('does not reconcile stale or changed unknown proposals', async () => {
  const current = proposal('unknown')
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/v1/cases/') ? response(detail({ ...current, status: 'executed' })) : response({ detail: 'Unexpected mutation' }, 409))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<ActionCard proposal={current} detail={detail(current)} token="operator" stale={false} onChanged={vi.fn()} />)
  await user.type(screen.getByLabelText('Підстава звірки'), 'Перевірено')
  await user.click(screen.getByRole('checkbox'))
  await user.click(screen.getByRole('button', { name: 'Записати результат звірки' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Стан дії змінився'))
  expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/reconcile'))).toBe(false)
})
