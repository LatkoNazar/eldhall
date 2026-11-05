import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { AppLink } from './components/AppLink'
import { navigate, registerNavigationGuard, useAppLocation } from './lib/navigation'

const time = '2026-10-31T10:00:00.000Z'
const ticket = (id: string) => ({ id, businessId: 'business-1', customerId: id, customerName: id, status: 'open', priority: 'P3', intent: null, analysis: null, ownership: 'staff', ownershipVersion: 0, assignedTo: null, createdAt: time, updatedAt: time })
const source = (id: string, businessId: string) => ({ id, businessId, title: id, content: `Content ${id}`, category: 'General', status: 'draft', version: 1, updatedAt: time })
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
function unloadIsPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
function mockApi() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/v1/operator/session') return response({ authenticated: true })
    if (path === '/api/v1/cases') return response([ticket('case-a'), ticket('case-b')])
    if (path === '/api/v1/metrics') return response({ cases: 2, byStatus: { open: 2, awaiting_approval: 0, escalated: 0, resolved: 0 }, byPriority: { P1: 0, P2: 0, P3: 2 }, proposals: {}, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null })
    if (path.startsWith('/api/v1/cases/')) {
      const id = path.split('/').at(-1)!
      return response({ case: ticket(id), customer: { name: id, email: 'qa@example.test', plan: 'QA' }, messages: [{ id: `message-${id}`, caseId: id, role: 'customer', body: `Message ${id}`, createdAt: time }], proposals: [], payments: [], refunds: [], audit: [], runs: [] })
    }
    if (path === '/api/v1/businesses') return response({ businesses: [{ id: 'business-1', name: 'First business', currency: 'UAH' }, { id: 'business-2', name: 'Second business', currency: 'UAH' }] })
    if (path.startsWith('/api/v1/knowledge?')) {
      const business = new URL(path, window.location.origin).searchParams.get('businessId')!
      return response({ sources: business === 'business-1' ? [source('doc-a', business), source('doc-b', business)] : [source('doc-c', business)], capabilities: { create: true, update: true, publish: true, revoke: true } })
    }
    if (path === '/api/v1/team') return response({ members: [], capabilities: { invite: false, updateRole: false } })
    return response({ detail: 'Unneeded fixture endpoint' })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
beforeEach(() => {
  sessionStorage.clear()
  sessionStorage.setItem('support.operator', 'test-operator-token')
  window.history.replaceState({}, '', '/operator')
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

it('navigates inside the same dashboard shell and retains its case polling resource', async () => {
  const fetch = mockApi()
  const user = userEvent.setup()
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  await screen.findByText('Message case-a')
  const shell = document.querySelector('.app-shell')
  const sidebar = document.querySelector('.sidebar')
  const header = document.querySelector('.topbar')
  const initialCasesReads = fetch.mock.calls.filter(([path]) => path === '/api/v1/cases').length
  await user.click(screen.getByRole('link', { name: 'Команда' }))
  expect(await screen.findByRole('heading', { name: 'Команда' })).toBeInTheDocument()
  expect(window.location.pathname).toBe('/operator/team')
  await user.click(screen.getByRole('link', { name: 'Аналітика' }))
  expect(await screen.findByRole('heading', { name: 'Аналітика підтримки' })).toBeInTheDocument()
  expect(document.querySelector('.app-shell')).toBe(shell)
  expect(document.querySelector('.sidebar')).toBe(sidebar)
  expect(document.querySelector('.topbar')).toBe(header)
  expect(fetch.mock.calls.filter(([path]) => path === '/api/v1/cases')).toHaveLength(initialCasesReads)
})

it('clears stale route search and reacts immediately to a same-path case deep link', async () => {
  mockApi()
  const user = userEvent.setup()
  render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  await screen.findByText('Message case-a')
  await user.type(screen.getByRole('textbox', { name: /Пошук звернень/ }), 'no matching customer')
  expect(screen.queryByText('Message case-b')).not.toBeInTheDocument()
  act(() => { navigate('/operator?caseId=case-b') })
  expect(await screen.findByText('Message case-b')).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: /Пошук звернень/ })).toHaveValue('')
})

it('updates same-path document and business selection instead of retaining initializer-only state', async () => {
  mockApi()
  render(<App />)
  act(() => { navigate('/operator/knowledge?businessId=business-1&documentId=doc-a') })
  expect(await screen.findByLabelText('Вміст')).toHaveValue('Content doc-a')
  act(() => { navigate('/operator/knowledge?businessId=business-1&documentId=doc-b') })
  expect(await screen.findByLabelText('Вміст')).toHaveValue('Content doc-b')
  act(() => { navigate('/operator/knowledge?businessId=business-2&documentId=doc-c') })
  expect(await screen.findByLabelText('Вміст')).toHaveValue('Content doc-c')
  expect(screen.getByLabelText('Бізнес')).toHaveValue('business-2')
})

it('handles browser Back/Forward and normalized trailing-slash routes without replacing the shell', async () => {
  mockApi()
  render(<App />)
  await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
  const shell = document.querySelector('.app-shell')
  act(() => { navigate('/operator/team/') })
  expect(await screen.findByRole('heading', { name: 'Команда' })).toBeInTheDocument()
  act(() => { navigate('/operator/analytics') })
  await screen.findByRole('heading', { name: 'Аналітика підтримки' })
  act(() => window.history.back())
  await waitFor(() => expect(window.location.pathname).toBe('/operator/team/'))
  expect(await screen.findByRole('heading', { name: 'Команда' })).toBeInTheDocument()
  act(() => window.history.forward())
  await waitFor(() => expect(window.location.pathname).toBe('/operator/analytics'))
  expect(await screen.findByRole('heading', { name: 'Аналітика підтримки' })).toBeInTheDocument()
  expect(document.querySelector('.app-shell')).toBe(shell)
})

it('keeps modified, new-tab, download, external and explicit fragment anchors native', () => {
  const seen: boolean[] = []
  const observe = (event: MouseEvent) => { seen.push(event.defaultPrevented); event.preventDefault() }
  document.addEventListener('click', observe)
  const view = render(<><AppLink href="/operator/team">Internal</AppLink><AppLink href="/operator/team" target="_blank">New tab</AppLink><AppLink href="/operator/team" download>Download</AppLink><AppLink href="https://example.test/">External</AppLink><AppLink href="/operator#main-content">Fragment</AppLink><AppLink href="/operator#">Empty fragment</AppLink></>)
  try {
    fireEvent.click(screen.getByText('Internal'), { ctrlKey: true })
    fireEvent.click(screen.getByText('Internal'), { metaKey: true })
    for (const label of ['New tab', 'Download', 'External', 'Fragment', 'Empty fragment']) fireEvent.click(screen.getByText(label))
    expect(seen).toEqual(Array(7).fill(false))
  } finally { document.removeEventListener('click', observe); view.unmount() }
})

it('preserves unsaved knowledge edits when client navigation is declined', async () => {
  mockApi()
  window.history.replaceState({}, '', '/operator/knowledge?businessId=business-1&documentId=doc-a')
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const user = userEvent.setup()
  render(<App />)
  const title = await screen.findByLabelText('Назва')
  expect(unloadIsPrevented()).toBe(false)
  await user.type(title, ' unsaved')
  expect(unloadIsPrevented()).toBe(true)
  await user.click(screen.getByRole('link', { name: 'Команда' }))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(window.location.pathname).toBe('/operator/knowledge')
  expect(screen.getByLabelText('Назва')).toHaveValue('doc-a unsaved')
  confirm.mockReturnValue(true)
  await user.click(screen.getByRole('link', { name: 'Команда' }))
  expect(await screen.findByRole('heading', { name: 'Команда' })).toBeInTheDocument()
  expect(unloadIsPrevented()).toBe(false)
})

it('warns only for an unsent reply and releases unload and navigation guards after unmount', async () => {
  mockApi()
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const user = userEvent.setup()
  const view = render(<App />)
  await screen.findByRole('heading', { name: 'Вхідні звернення' })
  await screen.findByText('Message case-a')
  const reply = screen.getByLabelText(/Відповідь клієнту/)
  expect(unloadIsPrevented()).toBe(false)
  await user.type(reply, 'Unsent reply')
  expect(unloadIsPrevented()).toBe(true)
  await user.click(screen.getByRole('link', { name: 'Команда' }))
  expect(confirm).toHaveBeenCalledOnce()
  expect(window.location.pathname).toBe('/operator')
  expect(reply).toHaveValue('Unsent reply')
  await user.clear(reply)
  expect(unloadIsPrevented()).toBe(false)
  await user.type(reply, 'Another unsent reply')
  expect(unloadIsPrevented()).toBe(true)
  view.unmount()
  expect(unloadIsPrevented()).toBe(false)
  act(() => { expect(navigate('/operator/team')).toBe(true) })
  expect(confirm).toHaveBeenCalledOnce()
})

it('allows dirty same-page native fragments and restores the exact entry after rejected multi-step Back', async () => {
  function Probe() { return <output>{useAppLocation()}</output> }
  render(<Probe />)
  act(() => { navigate('/operator/knowledge') })
  const guard = vi.fn(() => false)
  let removeGuard = registerNavigationGuard(guard)
  try {
    await act(async () => { window.location.hash = 'main-content'; await new Promise(resolve => setTimeout(resolve, 25)) })
    expect(guard).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('/operator/knowledge#main-content')
    removeGuard()
    act(() => { navigate('/operator/settings') })
    removeGuard = registerNavigationGuard(guard)
    act(() => window.history.go(-2))
    await waitFor(() => expect(guard).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(window.location.pathname).toBe('/operator/settings'))
    expect(screen.getByRole('status')).toHaveTextContent('/operator/settings')
  } finally { removeGuard() }
})
