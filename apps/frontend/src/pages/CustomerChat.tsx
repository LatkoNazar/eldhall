import { useI18n } from '../i18n'
import { LanguagePicker } from '../components/LanguagePicker'
import { ErrorNotice } from '../components/ErrorNotice'
import { currentAnalytics } from '@eldhall/analytics'
import { AppLink } from '../components/AppLink'
import { useState } from 'react'
import { Badge, Brand, Icon, Notice } from '../components/ui'
import { MessageThread } from '../components/MessageThread'
import { readSession, request, saveSession } from '../lib/api'
import type { CustomerCase, CustomerMessageResult, Persona } from '../lib/api'
import { useResource } from '../lib/useResource'

export function CustomerChat() {
  const { t } = useI18n()
  const personas = useResource<Persona[]>('/chat/personas', '')
  const [session, setSession] = useState(() => readSession('support.customer'))
  const [draftToken, setDraftToken] = useState('')
  const [caseId, setCaseId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  async function start(token: string) {
    if (!token.trim() || busy) return
    setBusy(true); setError(null)
    try { const result = await request<{ id: string }>('/chat/cases', token, { method: 'POST', customer: true }); saveSession('support.customer', token); setSession(token); setCaseId(result.id); try { currentAnalytics().track('support_case_created', {}) } catch { /* Tracking never changes a created case. */ } }
    catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  return <main className={`customer-page ${caseId ? 'customer-page-active' : ''}`} tabIndex={0}><header><Brand /><LanguagePicker /><AppLink href="/operator">{t("core.chat.operatorLink")}</AppLink></header><div className="customer-intro"><span className="eyebrow">{t("core.chat.eyebrow")}</span><h1>{t("core.chat.title")}</h1><p>{t("core.chat.intro")}</p></div><section className="customer-chat card">{caseId ? <ActiveChat key={caseId} id={caseId} session={session} onNew={() => setCaseId('')} /> : <div className="chat-start"><Icon name="inbox" size={34} /><h2>{t("core.chat.startTitle")}</h2>{personas.data && personas.data.length > 0 ? <><Badge>{t("core.chat.demoProfiles")}</Badge><p className="muted">{t("core.chat.demoNotice")}</p><div className="persona-list">{personas.data.map(persona => <button key={persona.sessionToken} disabled={busy} onClick={() => void start(persona.sessionToken)}><strong>{persona.name}</strong><span>{persona.businessName} · {persona.plan}</span><Icon name="arrow" /></button>)}</div></> : <><p className="muted">{t("core.chat.sessionHint")}</p><form onSubmit={event => { event.preventDefault(); void start(draftToken || session) }}><label htmlFor="customer-session">{t("core.chat.sessionKey")}</label><input id="customer-session" type="password" autoComplete="off" value={draftToken || session} onChange={event => { setDraftToken(event.target.value); setSession('') }} required /><button className="primary full" disabled={busy || !(draftToken || session).trim()}>{busy ? t("core.chat.opening") : t("core.chat.start")}</button></form></>}{error !== null && <ErrorNotice error={error} />}</div>}</section><p className="customer-footnote">{t("core.chat.footer")}</p></main>
}

function ActiveChat({ id, session, onNew }: { id: string; session: string; onNew: () => void }) {
  const { t } = useI18n()
  const resource = useResource<CustomerCase>(`/chat/cases/${id}`, session, 2500, true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pendingBody, setPendingBody] = useState('')
  const [acceptedRun, setAcceptedRun] = useState<{ id: string; acceptedAt: number } | null>(null)
  const data = resource.data
  const awaitingRunConfirmation = acceptedRun !== null && data?.activeRun?.id !== acceptedRun.id && (resource.requestedAt === null || resource.requestedAt <= acceptedRun.acceptedAt)
  const activeRun = data?.ownership === 'staff' ? null : data?.activeRun
  const processing = data?.ownership !== 'staff' && (activeRun?.status === 'queued' || activeRun?.status === 'running' || awaitingRunConfirmation)
  const pending = activeRun?.status === 'queued' ? t("core.chat.queued")
    : activeRun?.status === 'running' ? t("core.chat.running")
      : processing ? t("core.chat.accepted")
        : busy && data?.ownership !== 'staff' ? t("core.chat.sendingMessage") : ''
  async function send() {
    if (!draft.trim() || busy || processing) return
    setBusy(true); setError(null)
    const body = draft.trim()
    setPendingBody(body)
    try {
      const result = await request<CustomerMessageResult>(`/chat/cases/${id}/messages`, session, { method: 'POST', customer: true, body: { body } })
      setAcceptedRun(result.runId && result.ownership !== 'staff' ? { id: result.runId, acceptedAt: Date.now() } : null)
      setDraft(''); setPendingBody(''); resource.refresh()
    } catch (cause) { setError(cause); resource.refresh() }
    finally { setBusy(false) }
  }
  return <>
    <div className="customer-chat-header"><span className="chat-brand-icon"><Icon name="spark" /></span><div><h2>{data?.businessName || t("core.chat.team")}</h2><span className="small muted">{t("core.chat.subtitle")}</span></div><button onClick={onNew} disabled={busy}>{t("core.chat.new")}</button></div>
    <div className="chat-status">{data && <Badge value={data.status} />}</div>
    {resource.error && <ErrorNotice error={resource.errorCause} />}
    <MessageThread customer messages={data?.messages ?? []} customerName={t("core.chat.you")} loading={resource.loading} pending={pending} />
    {activeRun?.status === 'failed' && <Notice error>{t("core.chat.runFailed")}</Notice>}
    {error !== null && <ErrorNotice error={error}>{pendingBody && <p>{t("core.chat.savedText")}</p>}</ErrorNotice>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void send() }}>
      <label htmlFor="customer-message" className="sr-only">{t("core.chat.message")}</label>
      <textarea id="customer-message" required maxLength={2000} disabled={busy || processing} value={draft} onChange={event => setDraft(event.target.value)} placeholder={processing ? t("core.chat.waitingPlaceholder") : t("core.chat.placeholder")} />
      <div className="composer-footer"><small className="muted">{draft.length}/2000</small><button className="primary" disabled={busy || processing || !draft.trim() || !!resource.error}><Icon name="send" size={18} />{busy ? t("core.common.sending") : processing ? t("core.chat.waitingAi") : t("core.common.send")}</button></div>
    </form>
  </>
}
