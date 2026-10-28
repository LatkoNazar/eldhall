import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

const healthy = {
  status: 'ok',
  dependencies: { postgres: 'ok', redis: 'ok', rabbitmq: 'ok' },
}

function response(body: unknown = healthy, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('backend connection', () => {
  it('shows a pending state before the server responds', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Перевіряємо підключення' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Перевіряємо…' })).toBeDisabled()
    expect(screen.getAllByText('Перевірка…')).toHaveLength(3)
  })

  it('checks the same-origin endpoint and displays successful dependencies', async () => {
    const fetch = vi.fn().mockResolvedValue(response())
    vi.stubGlobal('fetch', fetch)
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Усе працює' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/health/ready', expect.objectContaining({ signal: expect.any(AbortSignal), cache: 'no-store' }))
    expect(screen.getAllByText('Доступний')).toHaveLength(3)
    expect(screen.getByText(/Оновлено о/)).toBeInTheDocument()
  })

  it('recovers after a network failure when the user retries', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Offline')).mockResolvedValueOnce(response())
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Не вдалося підключитися' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))
    expect(await screen.findByRole('heading', { name: 'Усе працює' })).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('displays degraded readiness without claiming that every service is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...healthy, status: 'unavailable', dependencies: { ...healthy.dependencies, redis: 'unavailable' } }, 503)))
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Частина сервісів недоступна' })).toBeInTheDocument()
    const redis = screen.getByText('Redis').closest('li')!
    expect(within(redis).getByText('Недоступний')).toBeInTheDocument()
    expect(screen.getAllByText('Доступний')).toHaveLength(2)
  })

  it.each([
    ['invalid JSON shape', () => response({ status: 'ok' })],
    ['HTTP failure', () => response({ detail: 'Error' }, 500)],
    ['HTML instead of API JSON', () => new Response('<html></html>')],
  ])('shows a connection error for %s', async (_name, result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result()))
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Не вдалося підключитися' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Усе працює' })).not.toBeInTheDocument()
  })

  it('aborts the active request when the page unmounts', () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const { unmount } = render(<App />)
    const options = fetch.mock.calls[0]?.[1] as RequestInit | undefined
    unmount()
    expect(options?.signal?.aborted).toBe(true)
  })
})
