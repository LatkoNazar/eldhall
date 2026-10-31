import { AppLink } from '../components/AppLink'
import { useState } from 'react'
import { Badge, Brand, Icon, Notice } from '../components/ui'
import { MessageThread } from '../components/MessageThread'
import { errorText, readSession, request, saveSession } from '../lib/api'
import type { CustomerCase, CustomerMessageResult, Persona } from '../lib/api'
import { useResource } from '../lib/useResource'

export function CustomerChat() {
  const personas = useResource<Persona[]>('/chat/personas', '')
  const [session, setSession] = useState(() => readSession('support.customer'))
  const [draftToken, setDraftToken] = useState('')
  const [caseId, setCaseId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function start(token: string) {
    if (!token.trim() || busy) return
    setBusy(true); setError('')
    try { const result = await request<{ id: string }>('/chat/cases', token, { method: 'POST', customer: true }); saveSession('support.customer', token); setSession(token); setCaseId(result.id) }
    catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }
  return <main className="customer-page"><header><Brand /><AppLink href="/operator">Робочий простір оператора ↗</AppLink></header><div className="customer-intro"><span className="eyebrow">ПОРУЧ, КОЛИ ПОТРІБНО</span><h1>Поговорімо?</h1><p>Напишіть нам. AI перевірить дані, а оператор допоможе з важливим рішенням.</p></div><section className="customer-chat card">{caseId ? <ActiveChat key={caseId} id={caseId} session={session} onNew={() => setCaseId('')} /> : <div className="chat-start"><Icon name="inbox" size={34} /><h2>Почнімо розмову</h2>{personas.data && personas.data.length > 0 ? <><Badge>Демонстраційні профілі</Badge><p className="muted">Синтетичні клієнти. Платежі та повернення симулюються.</p><div className="persona-list">{personas.data.map(persona => <button key={persona.sessionToken} disabled={busy} onClick={() => void start(persona.sessionToken)}><strong>{persona.name}</strong><span>{persona.businessName} · {persona.plan}</span><Icon name="arrow" /></button>)}</div></> : <><p className="muted">Використайте сесію, надану вашим сервісом.</p><form onSubmit={event => { event.preventDefault(); void start(draftToken || session) }}><label htmlFor="customer-session">Ключ клієнтської сесії</label><input id="customer-session" type="password" autoComplete="off" value={draftToken || session} onChange={event => { setDraftToken(event.target.value); setSession('') }} required /><button className="primary full" disabled={busy || !(draftToken || session).trim()}>{busy ? 'Відкриваємо…' : 'Почати розмову'}</button></form></>}{error && <Notice error>{error}</Notice>}</div>}</section><p className="customer-footnote">Важливі дії проходять перевірку та погодження. Повернення коштів у цьому MVP — симуляція.</p></main>
}

function ActiveChat({ id, session, onNew }: { id: string; session: string; onNew: () => void }) {
  const resource = useResource<CustomerCase>(`/chat/cases/${id}`, session, 2500, true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingBody, setPendingBody] = useState('')
  const [acceptedRun, setAcceptedRun] = useState<{ id: string; acceptedAt: number } | null>(null)
  const data = resource.data
  const awaitingRunConfirmation = acceptedRun !== null && data?.activeRun?.id !== acceptedRun.id && (resource.requestedAt === null || resource.requestedAt <= acceptedRun.acceptedAt)
  const activeRun = data?.ownership === 'staff' ? null : data?.activeRun
  const processing = data?.ownership !== 'staff' && (activeRun?.status === 'queued' || activeRun?.status === 'running' || awaitingRunConfirmation)
  const pending = activeRun?.status === 'queued' ? 'Повідомлення прийнято. Очікуємо запуску AI…'
    : activeRun?.status === 'running' ? 'AI опрацьовує ваше повідомлення…'
      : processing ? 'Повідомлення прийнято. Очікуємо відповідь AI…'
        : busy && data?.ownership !== 'staff' ? 'Надсилаємо повідомлення…' : ''
  async function send() {
    if (!draft.trim() || busy || processing) return
    setBusy(true); setError('')
    const body = draft.trim()
    setPendingBody(body)
    try {
      const result = await request<CustomerMessageResult>(`/chat/cases/${id}/messages`, session, { method: 'POST', customer: true, body: { body } })
      setAcceptedRun(result.runId && result.ownership !== 'staff' ? { id: result.runId, acceptedAt: Date.now() } : null)
      setDraft(''); setPendingBody(''); resource.refresh()
    } catch (cause) { setError(errorText(cause)); resource.refresh() }
    finally { setBusy(false) }
  }
  return <>
    <div className="customer-chat-header"><span className="chat-brand-icon"><Icon name="spark" /></span><div><h2>{data?.businessName || 'Команда підтримки'}</h2><span className="small muted">AI та оператор поруч</span></div><button onClick={onNew} disabled={busy}>Новий діалог</button></div>
    <div className="chat-status">{data && <Badge value={data.status} />}</div>
    {resource.error && <Notice error>{resource.error}</Notice>}
    <MessageThread customer messages={data?.messages ?? []} customerName="Ви" loading={resource.loading} pending={pending} />
    {activeRun?.status === 'failed' && <Notice error>Запуск AI завершився помилкою. Перевірте повідомлення команди підтримки в історії діалогу.</Notice>}
    {error && <Notice error>{error}{pendingBody && <p>Ваш текст збережено в полі. Перевірте історію перед повторним надсиланням.</p>}</Notice>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void send() }}>
      <label htmlFor="customer-message" className="sr-only">Ваше повідомлення</label>
      <textarea id="customer-message" required maxLength={2000} disabled={busy || processing} value={draft} onChange={event => setDraft(event.target.value)} placeholder={processing ? 'Очікуємо завершення поточного запиту…' : 'Розкажіть, що сталося…'} />
      <div className="composer-footer"><small className="muted">{draft.length}/2000</small><button className="primary" disabled={busy || processing || !draft.trim() || !!resource.error}><Icon name="send" size={18} />{busy ? 'Надсилаємо…' : processing ? 'Очікуємо AI…' : 'Надіслати'}</button></div>
    </form>
  </>
}
