import { render, screen, waitFor } from '../test/render'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { KnowledgeImport } from './KnowledgeImport'
import { KnowledgeVersions } from './KnowledgeVersions'
import { parsePlans } from '../lib/knowledge'

const businessId = '30000000-0000-4000-8000-000000000001'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

it('imports an allow-listed page as an internal, plan-scoped draft', async () => {
  const fetch = vi.fn(async () => json({ id: 'd1', title: 'Години роботи' }, 201))
  vi.stubGlobal('fetch', fetch)
  const onImported = vi.fn()
  const user = userEvent.setup()
  render(<KnowledgeImport token="op" businessId={businessId} onImported={onImported} />)
  await user.type(screen.getByLabelText('Адреса сторінки'), 'https://help.example.com/hours')
  await user.type(screen.getByLabelText('Категорія'), 'Support')
  await user.selectOptions(screen.getByLabelText('Хто бачить'), 'internal')
  await user.type(screen.getByLabelText('Тарифи'), 'Annual, Annual , Premium monthly')
  await user.click(screen.getByRole('button', { name: 'Імпортувати як чернетку' }))
  await waitFor(() => expect(onImported).toHaveBeenCalledWith({ key: 'operations.knowledge.importCreated', values: { title: 'Години роботи' } }, 'd1'))
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(`/api/v1/knowledge/import-url?businessId=${businessId}`)
  expect(JSON.parse(String(init.body))).toEqual({ category: 'Support', audience: 'internal', plans: ['Annual', 'Premium monthly'], url: 'https://help.example.com/hours' })
})

it('uploads a markdown file as base64 and shows server errors', async () => {
  const fetch = vi.fn(async () => json({ detail: 'Supported files: .md, .txt, .html' }, 415))
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  render(<KnowledgeImport token="op" businessId={businessId} onImported={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: 'З файлу' }))
  await user.upload(screen.getByLabelText('Файл'), new File(['# Refunds\n\nText'], 'refunds.md', { type: 'text/markdown' }))
  await user.type(screen.getByLabelText('Категорія'), 'Billing')
  await user.click(screen.getByRole('button', { name: 'Імпортувати як чернетку' }))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe(`/api/v1/knowledge/upload?businessId=${businessId}`)
  expect(JSON.parse(String(init.body)).filename).toBe('refunds.md')
})

it('lists the saved versions of a source', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ versions: [
    { id: 'd1', version: 2, status: 'published', title: 'T', content: 'Нова версія', updatedAt: '2026-10-31T10:00:00.000Z' },
    { id: 'd1', version: 1, status: 'draft', title: 'T', content: 'Стара версія', updatedAt: '2026-10-31T09:00:00.000Z' },
  ] })))
  render(<KnowledgeVersions token="op" businessId={businessId} sourceId="d1" current={2} />)
  expect(await screen.findByText('Історія версій · 2')).toBeInTheDocument()
  expect(screen.getByText('Стара версія')).toBeInTheDocument()
})

it('parses plan lists', () => {
  expect(parsePlans(' Annual, ,Premium monthly, Annual ')).toEqual(['Annual', 'Premium monthly'])
  expect(parsePlans('')).toEqual([])
})
