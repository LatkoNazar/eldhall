import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { KnowledgeSearchTest } from './KnowledgeSearchTest'

const businessId = '30000000-0000-4000-8000-000000000001'
const result = {
  query: 'списали двічі', mode: 'hybrid', embedder: 'local:hashing-v1:768', tookMs: 3,
  hits: [{ id: 'd1', title: 'Політика повернень', version: 2, content: 'Повертаємо пізніше списання.', section: 'Політика повернень › Подвійне списання', score: 0.0328,
    passages: [{ section: 'Політика повернень › Подвійне списання', text: 'Повертаємо пізніше списання.', score: 0.0328, lexicalRank: 1, vectorRank: 1, similarity: 0.49 }] }],
}

it('asks the operator search route with the business scope and shows ranked passages', async () => {
  const index = { embedder: { id: 'local:hashing-v1:768' }, vectorStore: 'pgvector', chunks: 42, staleChunks: 0, published: 3, urlImport: true }
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/knowledge/index') ? index : result), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<KnowledgeSearchTest token="op-token" businessId={businessId} />)
  expect(screen.getByRole('button', { name: 'Перевірити' })).toBeDisabled()
  expect(await screen.findByText('Індекс: PostgreSQL + pgvector')).toBeInTheDocument()
  await user.type(screen.getByLabelText('Питання клієнта'), 'списали двічі')
  await user.type(screen.getByLabelText('Тариф клієнта'), 'Annual')
  await user.click(screen.getByRole('button', { name: 'Перевірити' }))
  expect(await screen.findByText('Знайдено джерел: 1', { exact: false })).toBeInTheDocument()
  expect(screen.getByText('Політика повернень › Подвійне списання')).toBeInTheDocument()
  expect(screen.getByText('вектор: 1 (0.49)')).toBeInTheDocument()
  const [url, init] = fetch.mock.calls.find(([path]) => String(path).includes('/knowledge/search')) as unknown as [string, RequestInit]
  expect(url).toBe(`/api/v1/knowledge/search?businessId=${businessId}&q=${encodeURIComponent('списали двічі')}&k=5&audience=customer&plan=Annual`)
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer op-token')
})

it('shows the server error instead of results', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Invalid operator token' }), { status: 401, headers: { 'Content-Type': 'application/json' } })))
  const user = userEvent.setup()
  render(<KnowledgeSearchTest token="bad" businessId={businessId} />)
  await user.type(screen.getByLabelText('Питання клієнта'), 'hours')
  await user.click(screen.getByRole('button', { name: 'Перевірити' }))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
})
