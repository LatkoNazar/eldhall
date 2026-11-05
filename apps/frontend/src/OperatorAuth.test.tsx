import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import App from './App'
import { consumeOperatorLink } from './lib/operator-link'
import { navigate } from './lib/navigation'

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const emptyMetrics = { cases: 0, byStatus: { open: 0, awaiting_approval: 0, escalated: 0, resolved: 0 }, byPriority: {}, proposals: {}, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null }
function mock(session: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    if (path === '/api/v1/operator/session') return session()
    if (path === '/api/v1/metrics') return reply(emptyMetrics)
    if (path === '/api/v1/cases' || path === '/api/v1/chat/personas') return reply([])
    return reply({}, 404)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
beforeEach(() => { sessionStorage.clear(); history.replaceState({}, '', '/operator') })

it('checks a manually entered key before private requests or storage, retaining accessible visibility controls', async () => {
  let resolve!: (value: Response) => void
  const fetch = mock(() => new Promise<Response>(done => { resolve = done }))
  const user = userEvent.setup()
  render(<App />)
  const input = screen.getByLabelText('Ключ доступу оператора')
  await user.type(input, 'synthetic-login-key')
  await user.click(screen.getByRole('button', { name: 'Показати ключ' }))
  expect(input).toHaveAttribute('type', 'text')
  expect(input).toHaveValue('synthetic-login-key')
  await user.click(screen.getByRole('button', { name: 'Приховати ключ' }))
  expect(input).toHaveAttribute('type', 'password')
  expect(fetch).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: /Відкрити робочий простір/ }))
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/operator/session'])
  expect(document.querySelector('.app-shell')).toBeNull()
  expect(sessionStorage.getItem('support.operator')).toBeNull()
  await act(async () => { resolve(reply({ authenticated: true })) })
  await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
  expect(sessionStorage.getItem('support.operator')).toBe('synthetic-login-key')
})

it('clears only the invalid stored operator key and never renders raw server errors', async () => {
  sessionStorage.setItem('support.operator', 'expired-operator')
  sessionStorage.setItem('support.customer', 'customer-session')
  sessionStorage.setItem('support.case', 'customer-case')
  const fetch = mock(() => reply({ detail: 'RAW_PRIVATE_KEY expired-operator' }, 401))
  render(<App />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Ключ недійсний')
  expect(sessionStorage.getItem('support.operator')).toBeNull()
  expect(sessionStorage.getItem('support.customer')).toBe('customer-session')
  expect(sessionStorage.getItem('support.case')).toBe('customer-case')
  expect(document.body).not.toHaveTextContent('RAW_PRIVATE_KEY')
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/operator/session'])
})

it('validates a scrubbed deeplink before replacing a stored key or rendering the workspace', async () => {
  sessionStorage.setItem('support.operator', 'old-stored-key')
  history.replaceState({}, '', '/operator#key=synthetic%2Bdeeplink')
  const incoming = consumeOperatorLink()
  let resolve!: (value: Response) => void
  const fetch = mock(() => new Promise<Response>(done => { resolve = done }))
  render(<App initialOperatorLink={incoming} />)
  expect(location.hash).toBe('')
  expect(sessionStorage.getItem('support.operator')).toBe('old-stored-key')
  expect(document.body).not.toHaveTextContent('synthetic+deeplink')
  expect(document.querySelector('.app-shell')).toBeNull()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/operator/session'])
  await act(async () => { resolve(reply({ authenticated: true })) })
  await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
  expect(sessionStorage.getItem('support.operator')).toBe('synthetic+deeplink')
})

it('returns an authenticated workspace to the key form on a current private-request401', async () => {
  sessionStorage.setItem('support.operator', 'valid-then-expired')
  sessionStorage.setItem('support.customer', 'preserved-customer')
  let respond!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/v1/operator/session') return reply({ authenticated: true })
    if (String(input) === '/api/v1/cases') return new Promise<Response>(done => { respond = done })
    return reply(emptyMetrics)
  }))
  render(<App />)
  await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
  await act(async () => { respond(reply({ detail: 'RAW_PRIVATE_ERROR' }, 401)) })
  expect(await screen.findByLabelText('Ключ доступу оператора')).toBeInTheDocument()
  expect(document.querySelector('.app-shell')).toBeNull()
  expect(sessionStorage.getItem('support.operator')).toBeNull()
  expect(sessionStorage.getItem('support.customer')).toBe('preserved-customer')
  expect(document.body).not.toHaveTextContent('RAW_PRIVATE_ERROR')
})

it('does not remove a different stored key when an incoming deeplink is rejected', async () => {
  sessionStorage.setItem('support.operator', 'retained-key')
  mock(() => reply({ detail: 'private-invalid-candidate' }, 401))
  render(<App initialOperatorLink={{ key: 'rejected-link-key' }} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Ключ недійсний')
  expect(sessionStorage.getItem('support.operator')).toBe('retained-key')
  expect(document.querySelector('.app-shell')).toBeNull()
  expect(screen.getByLabelText('Ключ доступу оператора')).toHaveValue('')
})

it.each(['hashchange', 'popstate', 'spa'])('consumes a same-document%s deeplink before observers and validates before storage', async entry => {
  let resolve!: (value: Response) => void
  const fetch = mock(() => new Promise<Response>(done => { resolve = done }))
  render(<App />)
  const observed: string[] = []
  const observer = () => { observed.push(location.hash) }
  window.addEventListener('hashchange', observer)
  window.addEventListener('popstate', observer)
  try {
    act(() => {
      if (entry === 'spa') navigate('/operator#key=same-document-key')
      else {
        history.replaceState({}, '', '/operator#key=same-document-key')
        window.dispatchEvent(entry === 'hashchange' ? new HashChangeEvent('hashchange') : new PopStateEvent('popstate'))
      }
    })
    expect(location.hash).toBe('')
    expect(observed.every(hash => hash === '')).toBe(true)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/operator/session'])
    expect(sessionStorage.getItem('support.operator')).toBeNull()
    expect(document.querySelector('.app-shell')).toBeNull()
    expect(document.body).not.toHaveTextContent('same-document-key')
    await act(async () => { resolve(reply({ authenticated: true })) })
    await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
    expect(sessionStorage.getItem('support.operator')).toBe('same-document-key')
  } finally {
    window.removeEventListener('hashchange', observer)
    window.removeEventListener('popstate', observer)
  }
})

it('scrubs a same-document customer deeplink without adopting or validating its operator key', async () => {
  history.replaceState({}, '', '/chat')
  const fetch = mock(() => reply({ authenticated: true }))
  render(<App />)
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  act(() => {
    history.replaceState({}, '', '/chat#key=discarded-operator-key')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  expect(location.hash).toBe('')
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/operator/session'))).toBe(false)
  expect(sessionStorage.getItem('support.operator')).toBeNull()
})

it('sanitizes a different SPA destination before writing history or validating its key', async () => {
  const fetch = mock(() => new Promise<Response>(() => {}))
  render(<App />)
  const write = vi.spyOn(history, 'pushState')
  act(() => { expect(navigate('/operator/team#key=spa-candidate')).toBe(true) })
  expect(write).toHaveBeenCalledTimes(1)
  expect(write.mock.calls[0]?.[2]).toBe('/operator/team')
  expect(location.pathname + location.hash).toBe('/operator/team')
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/v1/operator/session'])
  expect(sessionStorage.getItem('support.operator')).toBeNull()
})

it.each(['503', 'network'])('preserves a stored key on%s and retries only validation after an explicit click', async failure => {
  sessionStorage.setItem('support.operator', 'retry-synthetic-key')
  let count = 0
  const fetch = mock(() => {
    if (++count > 1) return reply({ authenticated: true })
    if (failure === 'network') throw new Error('RAW_PRIVATE_NETWORK')
    return reply({ detail: 'RAW_PRIVATE_503' }, 503)
  })
  render(<App />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося перевірити ключ')
  expect(sessionStorage.getItem('support.operator')).toBe('retry-synthetic-key')
  expect(document.querySelector('.app-shell')).toBeNull()
  expect(document.body).not.toHaveTextContent('RAW_PRIVATE')
  expect(fetch).toHaveBeenCalledTimes(1)
  await userEvent.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
  await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
  expect(count).toBe(2)
})

it.each([200, 401])('ignores an old validation%s after a different key has been accepted', async status => {
  sessionStorage.setItem('support.operator', 'old-key')
  let old!: (value: Response) => void
  let count = 0
  mock(() => ++count === 1 ? new Promise<Response>(resolve => { old = resolve }) : reply({ authenticated: true }))
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Ввести інший ключ' }))
  await user.type(screen.getByLabelText('Ключ доступу оператора'), 'new-key')
  await user.click(screen.getByRole('button', { name: /Відкрити робочий простір/ }))
  await waitFor(() => expect(document.querySelector('.app-shell')).toBeInTheDocument())
  await act(async () => { old(reply({ authenticated: status === 200 }, status)) })
  expect(sessionStorage.getItem('support.operator')).toBe('new-key')
  expect(document.querySelector('.app-shell')).toBeInTheDocument()
})

it('keeps customer routes independent from stored or incoming operator keys', async () => {
  history.replaceState({}, '', '/chat')
  sessionStorage.setItem('support.operator', 'stored-operator')
  const fetch = mock(() => reply({ authenticated: true }))
  render(<App initialOperatorLink={{ key: 'incoming-key' }} />)
  await waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/operator/session'))).toBe(false)
  expect(sessionStorage.getItem('support.operator')).toBe('stored-operator')
})

it('requires authenticated:true and retains unavailable state for malformed success payloads', async () => {
  sessionStorage.setItem('support.operator', 'synthetic-key')
  mock(() => reply({ authenticated: false }))
  render(<App />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося перевірити ключ')
  expect(document.querySelector('.app-shell')).toBeNull()
  expect(sessionStorage.getItem('support.operator')).toBe('synthetic-key')
})
