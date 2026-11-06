import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { render } from '../test/render'
import { requestFixture, uuid } from '../test/request-fixtures'
import { RequestInspector } from './RequestInspector'
import { RequestTransitionForm } from './RequestTransitionForm'
import { CaseWorkspace } from '../pages/Inbox'
import { MessageThread } from './MessageThread'
import { LanguagePicker } from './LanguagePicker'

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function inspector(detail = requestFixture(), selectedId: string | null = null, onSelect = vi.fn()) {
  return <RequestInspector detail={detail} token="synthetic-operator" stale={false} selectedId={selectedId} onSelect={onSelect} onShowSource={vi.fn()} onChanged={vi.fn()} />
}

it('shows four actual requests with dependencies and keeps request lifecycle separate from action status', async () => {
  const detail = requestFixture()
  const select = vi.fn()
  const view = render(inspector(detail, null, select))
  expect(view.container.querySelectorAll('.request-catalog-card')).toHaveLength(4)
  expect(screen.getByText('Залежить від іншого запиту')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: /Відкрити запит R-03/ }))
  expect(select).toHaveBeenLastCalledWith(uuid(3))
  detail.proposals[0]!.status = 'executed'
  view.rerender(inspector(detail, uuid(3), select))
  expect(screen.getByRole('heading', { level: 2, name: 'Refund duplicate charge' })).toHaveFocus()
  expect(view.container.querySelector('.request-inspector-header')).toHaveTextContent('Очікує менеджера')
  expect(screen.queryByRole('heading', { name: 'Явно пов’язані платежі' })).toBeInTheDocument()
})

it('shows current-revision approval and execution readiness without completing the customer goal or reusing old approvals', () => {
  const detail = requestFixture()
  const item = detail.requestCatalog!.requests[2]!
  item.waitingOn = null
  detail.proposals[0]!.status = 'pending'
  const view = render(inspector(detail, item.id))
  const header = () => view.container.querySelector('.request-inspector-header')!
  expect(header()).toHaveTextContent('Очікує погодження')
  detail.proposals[0]!.policy.requiresApproval = false
  view.rerender(inspector(detail, item.id))
  expect(header()).toHaveTextContent('У роботі')
  detail.proposals[0]!.policy.requiresApproval = true
  detail.proposals[0]!.status = 'approved'
  view.rerender(inspector(detail, item.id))
  expect(header()).toHaveTextContent('Погоджено, очікує виконання')
  detail.proposals[0]!.status = 'executed'
  view.rerender(inspector(detail, item.id))
  expect(header()).toHaveTextContent('У роботі')
  expect(item.lifecycle).toBe('open')
  detail.proposals[0]!.status = 'approved'; item.revision = 2
  view.rerender(inspector(detail, item.id))
  expect(header()).toHaveTextContent('У роботі')
  detail.proposals[0]!.status = 'unknown'
  view.rerender(inspector(detail, item.id))
  expect(header()).toHaveTextContent('Виконання потребує перевірки')
})

it('keeps one ticket-level classification accessible across request selection without treating it as a request label', async () => {
  const detail = requestFixture()
  detail.case.analysis = { intent: 'other', summary: 'Several customer goals', reasoning: 'Common ticket context', priority: 'P2', tone: 'neutral', source: 'llm', model: 'fixture', sentiment: { label: 'calm', frustration: 0, escalationRisk: 0, urgency: 'low', signals: [] }, classification: { classId: 'customer-help', label: 'Customer help', confidence: 0.8, reason: 'Ticket-level classification', revision: 1, needsReview: false, source: 'llm', reasonCode: 'classified' } }
  const view = render(inspector(detail, uuid(3)))
  await userEvent.setup().click(screen.getByText('Контекст звернення'))
  const classification = screen.getByRole('region', { name: 'Класифікація тікета' })
  expect(classification).toHaveTextContent('Customer help')
  expect(view.container.querySelectorAll('.request-catalog-card')).toHaveLength(4)
  view.rerender(inspector(structuredClone(detail), uuid(1)))
  expect(screen.getAllByRole('region', { name: 'Класифікація тікета' })).toHaveLength(1)
  expect(screen.getByRole('region', { name: 'Класифікація тікета' })).toBe(classification)
})

it('retains one action host, execution uncertainty and rejection draft across catalog/shared-request changes', async () => {
  const detail = requestFixture()
  detail.requestCatalog!.requests[0]!.actions = [{ proposalId: uuid(301), requestRevision: 1 }]
  const fetch = vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => response(options?.method === 'POST' ? { proposal: { status: 'unknown' } } : detail, options?.method === 'POST' ? 502 : 200))
  vi.stubGlobal('fetch', fetch)
  const view = render(inspector(detail, uuid(3)))
  const host = view.container.querySelector('[data-proposal-host]')!
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(await screen.findByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
  view.rerender(inspector(structuredClone(detail), null))
  expect(host).toHaveAttribute('hidden')
  expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
  view.rerender(inspector(structuredClone(detail), uuid(1)))
  expect(view.container.querySelectorAll('[data-proposal-host]')).toHaveLength(1)
  expect(view.container.querySelector('[data-proposal-host]')).toBe(host)
  expect(screen.getByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  view.unmount()
  detail.proposals[0]!.status = 'pending'
  const pending = render(inspector(detail, uuid(3)))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Відхилити' }))
  await userEvent.setup().type(screen.getByLabelText('Причина відхилення'), 'Need a human review')
  const reason = screen.getByLabelText('Причина відхилення')
  pending.rerender(inspector(detail, null)); pending.rerender(inspector(detail, uuid(1)))
  expect(screen.getByLabelText('Причина відхилення')).toBe(reason)
  expect(reason).toHaveValue('Need a human review')
})

it('retains an in-flight execution guard when switching to another request that shares the same action', async () => {
  const detail = requestFixture()
  detail.requestCatalog!.requests[0]!.actions = [{ proposalId: uuid(301), requestRevision: 1 }]
  let finish: ((response: Response) => void) | undefined
  const fetch = vi.fn(async (_input: RequestInfo | URL, options?: RequestInit) => options?.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve }) : response(detail))
  vi.stubGlobal('fetch', fetch)
  const view = render(inspector(detail, uuid(3)))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.rerender(inspector(detail, uuid(1)))
  expect(screen.getByRole('button', { name: 'Виконуємо…' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Виконуємо…' }))
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  await act(async () => { finish!(response({ proposal: { status: 'unknown' } }, 502)) })
  expect(await screen.findByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
})

it('blocks new approvals under an old-revision unknown effect while leaving the old reconciliation controls available', () => {
  const detail = requestFixture()
  detail.requestCatalog!.requests[2]!.revision = 2
  detail.proposals[0]!.status = 'unknown'
  detail.proposals.push({ ...structuredClone(detail.proposals[0]!), id: uuid(302), status: 'pending' })
  detail.requestCatalog!.requests[2]!.actions.push({ proposalId: uuid(302), requestRevision: 2 })
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const view = render(inspector(detail, uuid(3)))
  expect(view.container.querySelector('.request-inspector-header')).toHaveTextContent('Виконання потребує перевірки')
  const approve = screen.getByRole('button', { name: 'Погодити дію' })
  expect(approve).toBeDisabled()
  fireEvent.click(approve)
  expect(view.container.querySelector('.external-reconcile select')).toBeEnabled()
  expect(view.container.querySelectorAll('[data-proposal-host]')).toHaveLength(2)
  expect(fetch).not.toHaveBeenCalled()
})

it('rechecks unresolved request effects before posting an approval after the catalog changes', async () => {
  const detail = requestFixture()
  detail.proposals[0]!.status = 'pending'
  const latest = structuredClone(detail)
  latest.proposals.push({ ...structuredClone(latest.proposals[0]!), id: uuid(302), status: 'unknown' })
  latest.requestCatalog!.requests[2]!.actions.push({ proposalId: uuid(302), requestRevision: 1 })
  const fetch = vi.fn<(input: RequestInfo | URL, options?: RequestInit) => Promise<Response>>().mockResolvedValue(response(latest))
  vi.stubGlobal('fetch', fetch)
  render(inspector(detail, uuid(3)))
  await userEvent.setup().click(screen.getByRole('button', { name: 'Погодити дію' }))
  expect(await screen.findByText('Стан або аргументи змінилися. Дані оновлено — перегляньте дію ще раз.')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/cases/${detail.case.id}`)
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
})

it('preserves selected request, one shared chat and a case draft through a real poll and source navigation', async () => {
  let detail = requestFixture()
  const fetch = vi.fn(async () => response(detail))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  const view = render(<CaseWorkspace token="synthetic-operator" cases={[detail.case]} search="" actionOnly={false} onChanged={vi.fn()} />)
  const reply = await screen.findByLabelText(/Відповідь клієнту/)
  await user.type(reply, 'Unsent case draft')
  const log = screen.getByRole('log')
  expect(log.querySelectorAll('article')).toHaveLength(6)
  const body = within(log).getByText(detail.messages[0]!.body)
  await user.click(within(log).getByRole('button', { name: /Відкрити запит R-03: Refund/ }))
  detail = structuredClone(detail)
  detail.requestCatalog!.version = 2
  detail.requestCatalog!.requests[0]!.revision = 2
  detail.requestCatalog!.requests[0]!.nextStep = 'Apartment number is still missing'
  detail.requestCatalog!.requests[0]!.sourceMessageIds.push(uuid(205))
  await waitFor(() => expect(view.container.querySelector('.request-catalog-card[data-request-id="' + uuid(1) + '"]')).toHaveTextContent('Apartment number is still missing'), { timeout: 4500 })
  expect(screen.getByRole('heading', { level: 2, name: 'Refund duplicate charge' })).toBeInTheDocument()
  expect(screen.getByRole('log')).toBe(log)
  expect(within(log).getByText(detail.messages[0]!.body)).toBe(body)
  expect(reply).toHaveValue('Unsent case draft')
  await user.click(screen.getByRole('button', { name: 'Показати у спільному діалозі' }))
  await waitFor(() => expect(body.closest('article')).toHaveFocus())
  expect(body).toHaveTextContent(detail.messages[0]!.body)
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('keeps unavailable selection honest, returns focus to the catalog and retains old actions for legacy data', async () => {
  const detail = requestFixture()
  const select = vi.fn()
  const view = render(inspector(detail, uuid(3), select))
  view.rerender(inspector(detail, uuid(999), select))
  expect(screen.getByText(/Обраний запит недоступний/)).toBeInTheDocument()
  expect(select).not.toHaveBeenCalled()
  view.rerender(inspector(detail, uuid(3), select))
  view.rerender(inspector(detail, null, select))
  expect(screen.getByRole('button', { name: /Відкрити запит R-03/ })).toHaveFocus()
  const legacy = { ...detail, requestCatalog: undefined }
  view.rerender(inspector(legacy, null, select))
  expect(screen.getByText('Запити клієнта ще не визначено.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Виконати погоджену дію' })).toBeEnabled()
  expect(view.container.querySelectorAll('[data-proposal-host]')).toHaveLength(1)
})

it('does not leak operator-only request annotations into the customer chat or reset the selected UUID on locale change', async () => {
  const detail = requestFixture()
  const view = render(<><LanguagePicker />{inspector(detail, uuid(3))}<MessageThread customer messages={detail.messages} customerName="Marta" requestLinks={{ [uuid(201)]: [{ id: uuid(3), label: 'R-03', title: 'Refund' }] }} selectedSourceIds={[uuid(201)]} /></>)
  expect(view.container.querySelector('.message-request-links')).toBeNull()
  expect(view.container.querySelector('.request-source-selected')).toBeNull()
  await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Мова інтерфейсу' }), 'de')
  expect(await screen.findByRole('heading', { name: 'Kundenziel' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { level: 2, name: 'Refund duplicate charge' })).toBeInTheDocument()
  expect(view.container.querySelector('[data-proposal-host]')).not.toHaveAttribute('hidden')
})

it('submits explicit evidence and exact CAS fields, preserves edits after409 and never replays a request transition', async () => {
  const detail = requestFixture()
  const catalog = detail.requestCatalog!
  const item = catalog.requests[0]!
  item.waitingOn = null
  detail.messages.push({ id: uuid(207), caseId: detail.case.id, role: 'customer', body: 'The address is now correct, thank you.', createdAt: '2026-11-06T10:01:00.000Z' }, { id: uuid(208), caseId: detail.case.id, role: 'operator', body: 'Earlier address confirmation', createdAt: '2026-11-06T09:59:00.000Z' })
  const fetch = vi.fn<(input: RequestInfo | URL, options?: RequestInit) => Promise<Response>>().mockResolvedValue(response({ detail: 'Version conflict' }, 409))
  vi.stubGlobal('fetch', fetch)
  const changed = vi.fn()
  const user = userEvent.setup()
  const view = render(<RequestTransitionForm item={item} catalog={catalog} detail={detail} token="synthetic-operator" stale={false} onChanged={changed} />)
  await user.click(screen.getByRole('button', { name: 'Зафіксувати виконання запиту' }))
  await user.type(screen.getByLabelText('Підстава'), 'Customer confirmed address')
  expect(screen.getByRole('button', { name: 'Зберегти стан запиту' })).toBeDisabled()
  expect(screen.queryByRole('checkbox', { name: /Change my address/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: /Earlier address confirmation/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: /The address is now correct, thank you/ }))
  await user.click(screen.getByRole('button', { name: 'Зберегти стан запиту' }))
  expect(await screen.findByText(/Запит змінився/)).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ version: 1, revision: 1, transition: 'fulfill', reason: 'Customer confirmed address', proof: { proposalIds: [], messageIds: [uuid(207)] } })
  expect(screen.getByLabelText('Підстава')).toHaveValue('Customer confirmed address')
  expect(screen.getByRole('button', { name: 'Зберегти стан запиту' })).toBeDisabled()
  const next = structuredClone(detail); next.requestCatalog!.version = 2
  view.rerender(<RequestTransitionForm item={next.requestCatalog!.requests[0]!} catalog={next.requestCatalog!} detail={next} token="synthetic-operator" stale={false} onChanged={changed} />)
  expect(fetch).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Переглянути актуальну версію' }))
  expect(screen.getByRole('button', { name: 'Зберегти стан запиту' })).toBeEnabled()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('blocks fulfill for unresolved dependencies or unknown action effects and rejects stale form submission', async () => {
  const detail = requestFixture()
  const catalog = detail.requestCatalog!
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const view = render(<RequestTransitionForm item={catalog.requests[1]!} catalog={catalog} detail={detail} token="synthetic-operator" stale={false} onChanged={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Зафіксувати виконання запиту' })).toBeDisabled()
  detail.proposals[0]!.status = 'unknown'
  view.rerender(<RequestTransitionForm item={catalog.requests[2]!} catalog={catalog} detail={detail} token="synthetic-operator" stale={false} onChanged={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Скасувати запит' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Зафіксувати виконання запиту' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Скасувати запит' }))
  expect(fetch).not.toHaveBeenCalled()
})
