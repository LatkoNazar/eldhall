import { useI18n, type UiMessage } from '../i18n'
import { ReadOnlyDemoBanner } from './ReadOnlyDemoBanner'
import { LanguagePicker } from './LanguagePicker'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, readSession, request, saveSession } from '../lib/api'
import { registerOperatorSession } from '../lib/operator-session'
import type { OperatorLink } from '../lib/operator-link'
import { Dashboard } from '../pages/Dashboard'
import { AppLink } from './AppLink'
import { Brand, Icon, Notice } from './ui'

type Session = { phase: 'form' | 'checking' | 'unavailable' | 'authenticated'; key: string; message?: UiMessage }
const sessionKey = 'support.operator'
const invalidKey: UiMessage = { key: 'core.auth.invalidKey' }
const unavailable: UiMessage = { key: 'core.auth.unavailable' }

export function OperatorGate({ location, initialLink, onLinkConsumed }: { location: string; initialLink: OperatorLink; onLinkConsumed: () => void }) {
  const { t, translateMessage } = useI18n()
  const [initial] = useState(() => initialLink.error ? '' : initialLink.key ?? readSession(sessionKey))
  const [session, setSession] = useState<Session>(() => ({ phase: initial ? 'checking' : 'form', key: initial, message: initialLink.error ? { key: 'core.auth.invalidLink' } : undefined }))
  const [draft, setDraft] = useState('')
  const [visible, setVisible] = useState(false)
  const lifecycle = useRef({ generation: 0, controller: null as AbortController | null, release: null as (() => void) | null })

  const reset = useCallback((message?: UiMessage, rejectedKey?: string) => {
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
        if (control.generation === current) reset({ key: 'core.auth.ended' }, key)
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
  return <main className="login-page" tabIndex={0}>
    <ReadOnlyDemoBanner />
    <div className="login-brand"><Brand /><LanguagePicker /></div>
    <section className="login-card card" aria-labelledby="login-title">
      <h1 id="login-title">{t("core.auth.title")}</h1>
      {session.message && <Notice error>{translateMessage(session.message)}</Notice>}
      {session.phase === 'checking' ? <div className="login-verification"><Notice><Icon name="loading" />  {t("core.auth.checking")}</Notice><button type="button" onClick={() => reset()}>{t("core.auth.otherKey")}</button></div>
        : session.phase === 'unavailable' ? <div className="login-verification"><button className="primary full" type="button" onClick={() => begin(session.key)}><Icon name="refresh" />{t("core.auth.retry")}</button><button className="full" type="button" onClick={() => reset()}>{t("core.auth.otherKey")}</button></div>
          : <form onSubmit={event => { event.preventDefault(); if (draft && draft.length <= 4096) begin(draft) }}>
            <label htmlFor="operator-token">{t("core.auth.keyLabel")}</label>
            <div className="login-key-field"><Icon name="key" /><input id="operator-token" type={visible ? 'text' : 'password'} value={draft} onChange={event => setDraft(event.target.value)} autoComplete="off" spellCheck={false} maxLength={4096} required aria-describedby="operator-key-hint" /><button className="icon-button" type="button" aria-label={visible ? t("core.auth.hideKey") : t("core.auth.showKey")} onClick={() => setVisible(value => !value)}><Icon name={visible ? 'eye-off' : 'eye'} /></button></div>
            <p className="field-hint" id="operator-key-hint">{t("core.auth.keyHint")}</p>
            {localDemo && <p className="field-hint">{t("core.auth.demoPrefix")} <code>1111</code>{t("core.auth.demoSuffix")}</p>}
            <button className="primary full" type="submit">{t("core.auth.open")} <Icon name="login" /></button>
          </form>}
      <AppLink className="subtle-link" href="/chat">{t("core.auth.testAgent")} <Icon name="arrow" size={16} /></AppLink>
    </section>
  </main>
}
