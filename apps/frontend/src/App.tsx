import { useEffect, useState } from 'react'
import { fetchReadiness, serviceNames } from './lib/health'
import type { Readiness, Service } from './lib/health'

type Connection =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'complete'; readiness: Readiness; checkedAt: Date }

export default function App() {
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10_000)
    let active = true

    void fetchReadiness(controller.signal)
      .then((readiness) => {
        if (active) setConnection({ phase: 'complete', readiness, checkedAt: new Date() })
      })
      .catch(() => {
        if (active) setConnection({ phase: 'error' })
      })
      .finally(() => window.clearTimeout(timeout))

    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [attempt])

  const healthy = connection.phase === 'complete'
    && connection.readiness.status === 'ok'
    && Object.values(connection.readiness.dependencies).every((value) => value === 'ok')
  const loading = connection.phase === 'loading'
  const heading = loading
    ? 'Перевіряємо підключення'
    : healthy
      ? 'Усе працює'
      : connection.phase === 'error'
        ? 'Не вдалося підключитися'
        : 'Частина сервісів недоступна'

  function refresh() {
    setConnection({ phase: 'loading' })
    setAttempt((value) => value + 1)
  }

  return (
    <div className="workspace">
      <header className="header">
        <a className="brand" href="/" aria-label="Starter — головна">
          <span className="brand-mark" aria-hidden="true">s.</span>
          <span>Starter</span>
        </a>
        <span className="header-note">Початок чогось нового</span>
      </header>

      <main>
        <section className="intro" aria-labelledby="intro-title">
          <p className="eyebrow"><span aria-hidden="true" /> Робочий простір</p>
          <h1 id="intro-title">Від ідеї —<br />до першої версії<span className="accent">.</span></h1>
          <p className="intro-copy">Тут починається твій застосунок.<br />Основа готова. Час створювати своє.</p>
        </section>

        <section className="connection-card" aria-labelledby="connection-title">
          <div className="card-header">
            <div>
              <p className="eyebrow">Підключення</p>
              <h2 id="connection-title">Стан застосунку</h2>
            </div>
            <span className={`connection-icon ${loading ? 'is-loading' : healthy ? 'is-healthy' : 'is-error'}`} aria-hidden="true">
              {loading ? '↻' : healthy ? '✓' : '!'}
            </span>
          </div>

          <div className="connection-summary" role="status" aria-live="polite" aria-atomic="true">
            <h3>{heading}</h3>
            <p>
              {loading
                ? 'Зачекай мить, отримуємо відповідь від сервера.'
                : healthy
                  ? 'Сервер відповідає, усі залежності доступні.'
                  : 'Перевір з’єднання та спробуй ще раз.'}
            </p>
          </div>

          <ul className="services" aria-label="Залежності сервера">
            {(Object.entries(serviceNames) as [Service, string][]).map(([key, name]) => {
              const available = connection.phase === 'complete' && connection.readiness.dependencies[key] === 'ok'
              const label = loading ? 'Перевірка…' : connection.phase === 'error' ? 'Немає даних' : available ? 'Доступний' : 'Недоступний'
              return (
                <li key={key}>
                  <span className="service-name">{name}</span>
                  <span className={`service-status ${loading || connection.phase === 'error' ? 'is-pending' : available ? 'is-healthy' : 'is-error'}`}>
                    <span className="status-dot" aria-hidden="true" />{label}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="card-footer">
            <span className="checked-at">
              {connection.phase === 'complete'
                ? `Оновлено о ${connection.checkedAt.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`
                : loading ? 'Очікуємо відповідь' : 'Відповідь не отримано'}
            </span>
            <button type="button" onClick={refresh} disabled={loading}>
              <span aria-hidden="true">↻</span> {loading ? 'Перевіряємо…' : 'Перевірити ще раз'}
            </button>
          </div>
        </section>
      </main>

      <footer className="footer"><span>Місце для наступної великої ідеї.</span><span>React + TypeScript</span></footer>
    </div>
  )
}
