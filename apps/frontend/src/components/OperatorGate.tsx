import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, readSession, request, saveSession } from '../lib/api'
import { registerOperatorSession } from '../lib/operator-session'
import type { OperatorLink } from '../lib/operator-link'
import { Dashboard } from '../pages/Dashboard'
import { AppLink } from './AppLink'
import { Brand, Icon, Notice } from './ui'

type Session = { phase: 'form' | 'checking' | 'unavailable' | 'authenticated'; key: string; message?: string }
const sessionKey = 'support.operator'
const invalidKey = 'Ключ недійсний або більше не діє. Перевірте його та спробуйте ще раз.'
const unavailable = 'Не вдалося перевірити ключ. З’єднання із сервером недоступне. Спробуйте ще раз.'

export function OperatorGate({ location, initialLink, onLinkConsumed }: { location: string; initialLink: OperatorLink; onLinkConsumed: () => void }) {
  const [initial] = useState(() => initialLink.error ? '' : initialLink.key ?? readSession(sessionKey))
  const [session, setSession] = useState<Session>(() => ({ phase: initial ? 'checking' : 'form', key: initial, message: initialLink.error ? 'Посилання для входу недійсне. Введіть ключ вручну.' : undefined }))
  const [draft, setDraft] = useState('')
  const [visible, setVisible] = useState(false)
  const lifecycle = useRef({ generation: 0, controller: null as AbortController | null, release: null as (() => void) | null })

  const reset = useCallback((message?: string, rejectedKey?: string) => {
    const control = lifecycle.current
    control.generation++
    control.controller?.abort()
    control.release?.()
    control.release = null
    if (rejectedKey === undefined || readSession(sessionKey) === rejectedKey) saveSession(sessionKey, '')
    setDraft('')
    setVisible(false)
    setSession({ phase: 'form', key: '', message })
  }, [])

  const validate = useCallback((key: string) => {
    const control = lifecycle.current
    const current = ++control.generation
    control.controller?.abort()
    control.release?.()
    control.release = null
    const pending = new AbortController()
    control.controller = pending
    return request<{ authenticated: true }>('/operator/session', key, { signal: pending.signal }).then(() => {
      if (control.generation !== current || pending.signal.aborted) return
      control.release = registerOperatorSession(key, () => {
        if (control.generation === current) reset('Сесію завершено. Увійдіть із чинним ключем.', key)
      })
      saveSession(sessionKey, key)
      setDraft('')
      setVisible(false)
      setSession({ phase: 'authenticated', key })
    }, (error: unknown) => {
      if (control.generation !== current || pending.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) reset(invalidKey, key)
      else setSession({ phase: 'unavailable', key, message: unavailable })
    })
  }, [reset])

  useEffect(() => {
    const control = lifecycle.current
    onLinkConsumed()
    if (initial) void validate(initial)
    return () => { control.generation++; control.controller?.abort(); control.release?.() }
  }, [initial, onLinkConsumed, validate])

  const begin = (key: string) => { setSession({ phase: 'checking', key }); void validate(key) }
  if (session.phase === 'authenticated') return <Dashboard token={session.key} location={location} onLogout={() => reset()} />
  const localDemo = import.meta.env.DEV && import.meta.env.MODE === 'local-demo' && window.location.hostname === '127.0.0.1'
  return <main className="login-page">
    <div className="login-brand"><Brand /></div>
    <section className="login-card card" aria-labelledby="login-title">
      <span className="eyebrow">РОБОЧИЙ ПРОСТІР ПІДТРИМКИ</span>
      <h1 id="login-title">Клієнт почутий.<br />Рішення під контролем.</h1>
      <p className="muted">Діалоги, перевірені дії AI та команда — в одному просторі.</p>
      {session.message && <Notice error>{session.message}</Notice>}
      {session.phase === 'checking' ? <div className="login-verification"><Notice><Icon name="loading" /> Перевіряємо ключ доступу…</Notice><button type="button" onClick={() => reset()}>Ввести інший ключ</button></div>
        : session.phase === 'unavailable' ? <div className="login-verification"><button className="primary full" type="button" onClick={() => begin(session.key)}><Icon name="refresh" />Перевірити ще раз</button><button className="full" type="button" onClick={() => reset()}>Ввести інший ключ</button></div>
          : <form onSubmit={event => { event.preventDefault(); if (draft && draft.length <= 4096) begin(draft) }}>
            <label htmlFor="operator-token">Ключ доступу оператора</label>
            <div className="login-key-field"><Icon name="key" /><input id="operator-token" type={visible ? 'text' : 'password'} value={draft} onChange={event => setDraft(event.target.value)} autoComplete="off" spellCheck={false} maxLength={4096} required aria-describedby="operator-key-hint" /><button className="icon-button" type="button" aria-label={visible ? 'Приховати ключ' : 'Показати ключ'} onClick={() => setVisible(value => !value)}><Icon name={visible ? 'eye-off' : 'eye'} /></button></div>
            <p className="field-hint" id="operator-key-hint">Ключ надає адміністратор. Після перевірки він зберігається лише на час цієї вкладки.</p>
            {localDemo && <p className="field-hint">Локальне демо: ключ <code>1111</code>. Усі дані синтетичні.</p>}
            <button className="primary full" type="submit">Відкрити робочий простір <Icon name="login" /></button>
          </form>}
      <AppLink className="subtle-link" href="/chat">Відкрити клієнтський чат <Icon name="arrow" size={16} /></AppLink>
    </section>
    <p className="login-footnote">AI пропонує. Людина погоджує. Сервер перевіряє та виконує.</p>
  </main>
}
