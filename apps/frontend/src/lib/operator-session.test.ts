import { expect, it, vi } from 'vitest'
import { request } from './api'
import { registerOperatorSession } from './operator-session'

it('ignores a late old401 even when the newer session uses the same key', async () => {
  let respond!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { respond = resolve })))
  const oldInvalid = vi.fn()
  const newInvalid = vi.fn()
  const oldRelease = registerOperatorSession('same-synthetic-key', oldInvalid)
  const pending = request('/cases', 'same-synthetic-key')
  oldRelease()
  const release = registerOperatorSession('same-synthetic-key', newInvalid)
  try {
    respond(new Response(JSON.stringify({ detail: 'private-old-error' }), { status: 401 }))
    await expect(pending).rejects.toThrow('Ключ доступу недійсний')
    expect(oldInvalid).not.toHaveBeenCalled()
    expect(newInvalid).not.toHaveBeenCalled()
  } finally { release() }
})

it('invalidates the current operator session on401 even if the payload is not JSON', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private</html>', { status: 401 })))
  const invalid = vi.fn()
  const release = registerOperatorSession('synthetic-key', invalid)
  try {
    await expect(request('/cases', 'synthetic-key')).rejects.toThrow()
    expect(invalid).toHaveBeenCalledTimes(1)
  } finally { release() }
})

it('keeps customer401 and operator503 separate and never retries a mutation', async () => {
  const fetch = vi.fn().mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 401 }))).mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 503 })))
  vi.stubGlobal('fetch', fetch)
  const invalid = vi.fn()
  const release = registerOperatorSession('shared-synthetic-value', invalid)
  try {
    await expect(request('/chat/cases/one', 'shared-synthetic-value', { customer: true })).rejects.toThrow()
    await expect(request('/proposals/one/execute', 'shared-synthetic-value', { method: 'POST', body: { argsHash: 'synthetic' } })).rejects.toThrow()
    expect(invalid).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0]![1].headers).toHaveProperty('X-Customer-Session', 'shared-synthetic-value')
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('Authorization')
  } finally { release() }
})
