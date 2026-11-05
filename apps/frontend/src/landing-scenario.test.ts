import { fireEvent, screen, within } from '@testing-library/dom'
import { beforeAll, expect, it, vi } from 'vitest'
import { loadLocale } from '../../landing/src/i18n/index.ts'
import { initScenario } from '../../landing/src/scenario'
import { SCENARIOS } from '../../landing/src/scenario-data'

beforeAll(() => loadLocale('uk'))

function walkthrough(onEvent?: Parameters<typeof initScenario>[1]) {
  document.body.innerHTML = `<section data-scenario>
    <button id="refund-tab" data-scenario-tab="refund">Повернення</button><button id="limit-tab" data-scenario-tab="limit">Понад ліміт</button>
    <div data-scenario-panel><ol data-scenario-progress></ol><div data-scenario-chat></div><span data-scenario-business></span><p data-scenario-kicker></p><h2 data-scenario-title></h2><p data-scenario-text></p><div data-scenario-detail></div><button data-scenario-prev>Назад</button><button data-scenario-next>Далі</button></div>
  </section>`
  initScenario(document, onEvent, 'uk')
  return document.querySelector<HTMLElement>('[data-scenario]')!
}

it('illustrates approval with zero effects before a separate simulated execution and rejects duplicate execution', () => {
  const fetch = vi.fn(() => { throw new Error('The illustrative walkthrough must not make API calls') })
  vi.stubGlobal('fetch', fetch)
  const section = walkthrough()
  fireEvent.click(screen.getByRole('button', { name: 'Крок 4: Рішення' }))
  expect(within(section).getByText('0 повернень · 0 викликів провайдера')).toBeInTheDocument()
  expect(within(section).getByText(/Approve лише записує згоду/)).toBeInTheDocument()
  expect(within(section).queryByText(/SIM-RF-DEMO-001/)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Далі' }))
  expect(within(section).getByText(/Симуляція завершена:/)).toHaveTextContent('SIM-RF-DEMO-001')
  expect(within(section).getByText('Повторний Execute')).toBeInTheDocument()
  expect(within(section).getByText('409 · вже виконано')).toBeInTheDocument()
  expect(within(section).getByText('Крок 5 · Execute · ілюстрація')).toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
})

it('retains the five-step keyboard flow and the denial scenario without simulated success', () => {
  const section = walkthrough()
  fireEvent.click(screen.getByRole('button', { name: 'Крок 4: Рішення' }))
  expect(screen.getByRole('button', { name: 'Крок 4: Рішення' })).toHaveFocus()
  expect(section.querySelectorAll('[data-scenario-progress] button')).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: 'Понад ліміт' }))
  fireEvent.click(screen.getByRole('button', { name: 'Крок 5: Результат' }))
  expect(within(section).getByText('refund: none')).toBeInTheDocument()
  expect(within(section).queryByText(/SIM-RF-DEMO-001/)).not.toBeInTheDocument()
})

it('contains no obsolete real-bank settlement promise in illustrative scenario messages', () => {
  const messages = Object.values(SCENARIOS).flatMap(scenario => scenario.steps.flatMap(step => step.chat ?? [])).map(message => message.text).join('\n')
  expect(messages).not.toMatch(/approved and submitted|3[–-]5 business days/i)
})

it('reports each scenario start and completion once without personal data or repeat inflation', () => {
  const track = vi.fn()
  walkthrough(track)
  expect(track).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /^Крок 5:/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Спочатку' }))
  fireEvent.click(screen.getByRole('button', { name: /^Крок 5:/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Понад ліміт' }))
  fireEvent.click(screen.getByRole('button', { name: /^Крок 5:/ }))
  expect(track.mock.calls).toEqual([
    ['demo_started', 'refund'], ['demo_completed', 'refund'],
    ['demo_started', 'limit'], ['demo_completed', 'limit'],
  ])
})

it('finishes the walkthrough even if its telemetry callback fails', () => {
  walkthrough(() => { throw new Error('collector unavailable') })
  fireEvent.click(screen.getByRole('button', { name: /^Крок 5:/ }))
  expect(screen.getByText('Крок 5 · Execute · ілюстрація')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Спочатку' })).toBeEnabled()
})
