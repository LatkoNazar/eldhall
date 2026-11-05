import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { render } from '../test/render'
import { detail, proposal } from '../test/presentation-fixtures'
import { ProposalContext } from './ProposalContext'
import { ActionCard } from './ActionCard'
import { CaseWorkspace } from '../pages/Inbox'
import { ReadOnlyDemoBanner } from './ReadOnlyDemoBanner'

function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }

it('separates requested delivery fields from a recorded result and never promotes unconfirmed output', () => {
  const current = { ...proposal('delivery', { shipment_id: 'ship-requested', status: 'change-requested' }), result: { data: { shipment_id: 'ship-recorded', status: 'delivered' } } }
  const view = render(<ProposalContext proposal={current} detail={detail(current)} />)
  const requested = screen.getByRole('region', { name: 'Запитані дані' })
  const confirmed = screen.getByRole('region', { name: 'Зафіксований результат' })
  expect(within(requested).getByText('ship-requested')).toBeInTheDocument()
  expect(within(confirmed).getByText('Для цього шаблону немає доступних підтверджених полів.')).toBeInTheDocument()
  expect(screen.queryByText('delivered')).not.toBeInTheDocument()
  view.rerender(<ProposalContext proposal={{ ...current, status: 'executed' }} detail={detail(current)} />)
  expect(within(confirmed).getByText('ship-recorded')).toBeInTheDocument()
  expect(within(requested).queryByText('ship-recorded')).not.toBeInTheDocument()
})

it('renders only bounded approved primitives as escaped text, leaving credentials and nested data out of new cards', () => {
  const malicious = '<img src=x onerror=alert(1)>'
  const current = proposal('warranty', { issue: malicious, product_id: 'product-1', api_key: 'PRIVATE_SECRET', nested: { authorization: 'PRIVATE_SECRET' } })
  const view = render(<ProposalContext proposal={current} detail={detail(current)} />)
  expect(screen.getByText(malicious)).toBeInTheDocument()
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container).not.toHaveTextContent('PRIVATE_SECRET')
  expect(view.container.querySelector('pre')).toBeNull()
})

it('identifies partial requested and recorded views without exposing omitted values or claiming unconfirmed output', () => {
  const current = proposal('delivery', { shipment_id: 'S1', delivery_date: 'tomorrow', new_address: 'UNMAPPED_PRIVATE_ADDRESS' })
  const view = render(<ProposalContext proposal={current} detail={detail(current)} />)
  const requested = screen.getByRole('region', { name: 'Запитані дані' })
  const confirmed = screen.getByRole('region', { name: 'Зафіксований результат' })
  expect(within(requested).getByText('S1')).toBeInTheDocument()
  expect(within(requested).getByRole('note')).toHaveTextContent('точні аргументи дії нижче')
  expect(within(confirmed).queryByRole('note')).not.toBeInTheDocument()
  expect(view.container).not.toHaveTextContent('UNMAPPED_PRIVATE_ADDRESS')
  expect(view.container).not.toHaveTextContent('tomorrow')
  view.rerender(<ProposalContext proposal={{ ...current, status: 'executed', result: { data: [{ shipment_id: 'UNMAPPED_RESULT' }] } }} detail={detail(current)} />)
  expect(within(confirmed).getByRole('note')).toHaveTextContent('деталі зафіксованого результату нижче')
  expect(within(confirmed).getByText('Для цього шаблону немає доступних підтверджених полів.')).toBeInTheDocument()
  expect(view.container).not.toHaveTextContent('UNMAPPED_RESULT')
})

it('keeps unrelated stored payments out of a delivery case and represents an empty domain honestly', async () => {
  const current = proposal('delivery', { shipment_id: 'ship-1' })
  const data = { ...detail(current), payments: [{ id: 'payment-unrelated', amountCents: 12345, currency: 'EUR', merchantRef: 'ref-1', status: 'captured', description: 'Unrelated old payment', createdAt: current.createdAt }] }
  vi.stubGlobal('fetch', vi.fn(async () => response(data)))
  const view = render(<CaseWorkspace token="synthetic-operator" cases={[data.case]} search="" actionOnly={false} onChanged={vi.fn()} businessNames={{ 'business-synthetic': 'Original business' }} />)
  expect(await screen.findByText('ship-1')).toBeInTheDocument()
  const inspector = screen.getByRole('complementary', { name: 'AI-копілот і дані звернення' })
  expect(within(inspector).getByText('Original business')).toBeInTheDocument()
  expect(within(inspector).queryByRole('heading', { name: 'Платежі' })).not.toBeInTheDocument()
  expect(within(inspector).queryByText('Unrelated old payment')).not.toBeInTheDocument()
  view.unmount()
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...data, proposals: [] })))
  render(<CaseWorkspace token="synthetic-operator" cases={[data.case]} search="" actionOnly={false} onChanged={vi.fn()} />)
  expect(await screen.findByText('Для цього звернення немає зафіксованих дій або бізнес-записів.')).toBeInTheDocument()
})

it('preserves the same action-card uncertainty latch when business presentation data refreshes', async () => {
  const current = { ...proposal('delivery', { shipment_id: 'ship-1' }), status: 'approved' as const }
  const data = detail(current)
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => response(init?.method === 'POST' ? { proposal: { status: 'unknown', error: 'Original provider diagnostic' } } : data, init?.method === 'POST' ? 502 : 200))
  vi.stubGlobal('fetch', fetch)
  const view = render(<ActionCard proposal={current} detail={data} token="synthetic-operator" stale={false} onChanged={vi.fn()} />)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Виконати погоджену дію' }))
  expect(await screen.findByText(/Повторне виконання заблоковано/)).toBeInTheDocument()
  view.rerender(<ActionCard proposal={{ ...current, args: { ...current.args, title: 'Updated business label' } }} detail={{ ...data, customer: { ...data.customer, plan: 'Updated plan' } }} token="synthetic-operator" stale={false} onChanged={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Виконати погоджену дію' })).not.toBeInTheDocument()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  expect(JSON.parse(String(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ argsHash: current.argsHash })
})

it('disables fixture-mode execution, ownership and send controls, with handler guards as a second boundary', async () => {
  vi.stubEnv('MODE', 'inspector-demo')
  try {
    const current = { ...proposal('delivery', { shipment_id: 'ship-1' }), status: 'approved' as const }
    const data = { ...detail(current), case: { ...detail(current).case, ownership: 'staff' as const } }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(data))
    vi.stubGlobal('fetch', fetch)
    const view = render(<><ReadOnlyDemoBanner /><CaseWorkspace token="synthetic-operator" cases={[data.case]} search="" actionOnly={false} onChanged={vi.fn()} /></>)
    expect(screen.getByRole('note')).toHaveTextContent('лише для читання')
    expect(await screen.findByRole('button', { name: 'Виконати погоджену дію' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Повернути AI' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Вирішено' })).toBeDisabled()
    const reply = screen.getByLabelText(/Відповідь клієнту/)
    expect(reply).toBeDisabled()
    fireEvent.change(reply, { target: { value: 'Attempted fixture write' } })
    fireEvent.submit(view.container.querySelector('form.composer')!)
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  } finally { vi.unstubAllEnvs() }
})
