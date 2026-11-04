import { render, screen, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { Dashboard } from './Dashboard'
import type { Metrics } from '../lib/api'

it('renders unknown outcomes separately without inflating the confirmed failed count', async () => {
  const metrics: Metrics = { cases: 1, byStatus: { open: 1, awaiting_approval: 0, resolved: 0, escalated: 0 }, byPriority: {}, proposals: { pending: 0, approved: 0, executing: 0, executed: 2, failed: 0, unknown: 3, denied: 0, rejected: 0, expired: 0, invalidated: 0 }, refundsIssuedCents: 0, agentRuns: 0, fallbackRuns: 0, avgAgentLatencyMs: null }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/metrics') ? metrics : []), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  window.history.replaceState({}, '', '/operator/analytics')
  render(<Dashboard token="synthetic-operator" location="/operator/analytics" onLogout={vi.fn()} />)
  const quality = await screen.findByRole('region', { name: 'Якість підтримки' })
  const outcomes = within(quality).getByText('Успішні / невдалі дії').closest('article')!
  const unknown = within(quality).getByText('Непідтверджені дії').closest('article')!
  expect(within(outcomes).getByText('2 / 0')).toBeInTheDocument()
  expect(within(unknown).getByText('3')).toBeInTheDocument()
  expect(unknown).toHaveTextContent('Результат потребує перевірки')
  expect(within(quality).getByText('N/A')).toBeInTheDocument()
})
