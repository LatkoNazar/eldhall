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

it('shows an external collection as read-only without offering remote reindex or internal access', async () => {
  const index = { embedder: { id: 'local:existing:384' }, vectorStore: 'qdrant', readOnly: true, collection: 'central', chunks: null, staleChunks: null, published: null, urlImport: false }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } })))
  render(<KnowledgeSearchTest token="op-token" businessId={businessId} />)
  expect(await screen.findByText('Індекс: Зовнішній Qdrant')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Переіндексувати' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Від імені')).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('central')
})

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

it.each([
  ['missing passages', { ...result, hits: [{ ...result.hits[0], passages: undefined }] }],
  ['non-numeric score', { ...result, hits: [{ ...result.hits[0], passages: [{ ...result.hits[0]!.passages[0], score: '0.03' }] }] }],
  ['missing similarity', { ...result, hits: [{ ...result.hits[0], passages: [{ ...result.hits[0]!.passages[0], similarity: undefined }] }] }],
  ['non-text passage', { ...result, hits: [{ ...result.hits[0], passages: [{ ...result.hits[0]!.passages[0], text: { value: 'invalid' } }] }] }],
])('rejects a malformed successful search with %s without crashing the workspace', async (_label, payload) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/knowledge/index') ? {} : payload), { headers: { 'Content-Type': 'application/json' } })))
  const user = userEvent.setup()
  render(<KnowledgeSearchTest token="op-token" businessId={businessId} />)
  await user.type(screen.getByLabelText('Питання клієнта'), 'hours')
  await user.click(screen.getByRole('button', { name: 'Перевірити' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Неочікувана відповідь сервера')
  expect(screen.getByRole('button', { name: 'Перевірити' })).toBeEnabled()
  expect(screen.queryByText('Знайдено джерел: 1', { exact: false })).not.toBeInTheDocument()
})

it.each([
  { embedder: null },
  { embedder: { id: {} }, vectorStore: 'memory', chunks: 0, staleChunks: 0, published: 0, urlImport: false },
  { embedder: { id: 'external' }, vectorStore: 'qdrant', chunks: null, staleChunks: null, published: null, urlImport: false, readOnly: true, collection: {} },
])('keeps search usable when the index response contains invalid rendered fields (%j)', async index => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/knowledge/index') ? index : result), { headers: { 'Content-Type': 'application/json' } })))
  const user = userEvent.setup()
  render(<KnowledgeSearchTest token="op-token" businessId={businessId} />)
  await user.type(screen.getByLabelText('Питання клієнта'), 'hours')
  await user.click(screen.getByRole('button', { name: 'Перевірити' }))
  expect(await screen.findByText('Знайдено джерел: 1', { exact: false })).toBeInTheDocument()
  expect(screen.queryByText(/^Індекс:/)).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it.each(['lexical', 'external'])('preserves the real %s search response variant', async mode => {
  const payload = { ...result, mode, hits: [{ ...result.hits[0], score: 0, passages: [{ ...result.hits[0]!.passages[0], score: 0, lexicalRank: null, vectorRank: null, similarity: null }] }] }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/knowledge/index') ? {} : payload), { headers: { 'Content-Type': 'application/json' } })))
  const user = userEvent.setup()
  render(<KnowledgeSearchTest token="op-token" businessId={businessId} />)
  await user.type(screen.getByLabelText('Питання клієнта'), 'hours')
  await user.click(screen.getByRole('button', { name: 'Перевірити' }))
  expect(await screen.findByText('Повертаємо пізніше списання.')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  if (mode === 'external') expect(screen.queryByText(/RRF/)).not.toBeInTheDocument()
  else expect(screen.getByText('RRF 0.0000')).toBeInTheDocument()
})
