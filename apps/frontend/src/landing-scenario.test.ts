import { fireEvent, screen, within } from '@testing-library/dom'
import { expect, it, vi } from 'vitest'
import { initScenario } from '../../landing/src/scenario'
import { SCENARIOS } from '../../landing/src/scenario-data'

function walkthrough() {
  document.body.innerHTML = `<section data-scenario>
    <button id="refund-tab" data-scenario-tab="refund">Повернення</button><button id="limit-tab" data-scenario-tab="limit">Понад ліміт</button>
    <div data-scenario-panel><ol data-scenario-progress></ol><div data-scenario-chat></div><span data-scenario-business></span><p data-scenario-kicker></p><h2 data-scenario-title></h2><p data-scenario-text></p><div data-scenario-detail></div><button data-scenario-prev>Назад</button><button data-scenario-next>Далі</button></div>
  </section>`
  initScenario()
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
