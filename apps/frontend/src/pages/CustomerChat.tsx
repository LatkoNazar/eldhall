import { useI18n } from '../i18n'
import { ReadOnlyDemoBanner } from '../components/ReadOnlyDemoBanner'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { LanguagePicker } from '../components/LanguagePicker'
import { ErrorNotice } from '../components/ErrorNotice'
import { currentAnalytics } from '@eldhall/analytics'
import { AppLink } from '../components/AppLink'
import { useEffect, useRef, useState } from 'react'
import { Badge, Brand, Icon, Notice } from '../components/ui'
import { MessageThread } from '../components/MessageThread'
import { readSession, request, saveSession } from '../lib/api'
import type { CustomerCase, CustomerMessageResult, Persona } from '../lib/api'
import { useResource } from '../lib/useResource'
import './customer-chat.css'

interface Conversation { id: string; session: string; isTest: boolean }

export function CustomerChat() {
  const { t } = useI18n()
  const personas = useResource<Persona[]>('/chat/personas', '')
  const demo = personas.data?.find(persona => persona.sessionToken.trim())
  const [chatRevision, setChatRevision] = useState(0)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const testChat = Boolean(demo || conversation?.isTest)
  const testSessionsPath = conversation?.isTest
    ? `/operator?environment=test&caseId=${encodeURIComponent(conversation.id)}`
    : '/operator?environment=test'

  return <main className="customer-page">
    <header className="customer-toolbar">
      <div className="customer-toolbar-identity">
        <Brand />
        <h1>{t(testChat ? 'core.nav.testAgent' : 'core.chat.title')}</h1>
      </div>
      <div className="customer-toolbar-actions">
        {testChat && <AppLink className="customer-test-sessions-link" href={testSessionsPath} aria-label={t('core.chat.testSessions')} title={t('core.chat.testSessions')}>
          <Icon name="clock" size={18} /><span>{t('core.chat.testSessions')}</span>
        </AppLink>}
        <AppLink className="customer-operator-link" href="/operator" aria-label={t('core.chat.operatorLink')} title={t('core.chat.operatorLink')}>
          <Icon name="inbox" size={18} /><span>{t('core.chat.operatorLink')}</span>
        </AppLink>
        <LanguagePicker />
      </div>
    </header>
    <ReadOnlyDemoBanner />
    <section className="customer-chat card">
      <ChatConversation
        key={chatRevision}
        conversation={conversation}
        demo={demo}
        preparing={personas.loading}
        focusOnMount={chatRevision > 0}
        onOpen={setConversation}
        onNew={() => { setConversation(null); setChatRevision(revision => revision + 1) }}
      />
    </section>
  </main>
}

function ChatConversation({ conversation, demo, preparing, focusOnMount, onOpen, onNew }: {
  conversation: Conversation | null
  demo?: Persona
  preparing: boolean
  focusOnMount: boolean
  onOpen: (conversation: Conversation) => void
  onNew: () => void
}) {
  const { t } = useI18n()
  const [draftToken, setDraftToken] = useState(() => readSession('support.customer'))
  const session = conversation?.session ?? demo?.sessionToken ?? draftToken.trim()
  const resource = useResource<CustomerCase>(conversation ? `/chat/cases/${conversation.id}` : null, session, 2500, true)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pendingBody, setPendingBody] = useState('')
  const [acceptedRun, setAcceptedRun] = useState<{ id: string; acceptedAt: number } | null>(null)
  const messageInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (focusOnMount) messageInput.current?.focus() }, [focusOnMount])
  const data = resource.data
  const awaitingRunConfirmation = acceptedRun !== null && data?.activeRun?.id !== acceptedRun.id && (resource.requestedAt === null || resource.requestedAt <= acceptedRun.acceptedAt)
  const activeRun = data?.ownership === 'staff' ? null : data?.activeRun
  const processing = data?.ownership !== 'staff' && (activeRun?.status === 'queued' || activeRun?.status === 'running' || awaitingRunConfirmation)
  const pending = activeRun?.status === 'queued' ? t("core.chat.queued")
    : activeRun?.status === 'running' ? t("core.chat.running")
      : processing ? t("core.chat.accepted")
        : busy ? t("core.chat.sendingMessage") : ''
  const readOnly = isReadOnlyDemo()
  const canSend = !readOnly && !preparing && !!session && !!draft.trim() && !busy && !processing && !resource.error
  async function send() {
    if (!canSend) return
    setBusy(true); setError(null)
    const body = draft.trim()
    setPendingBody(body)
    try {
      let id = conversation?.id
      if (!id) {
        const creationPath = demo ? '/chat/test-cases' : '/chat/cases'
        const opened = await request<{ id: string; isTest?: boolean }>(creationPath, session, { method: 'POST', customer: true })
        id = opened.id
        const isTest = opened.isTest === true
        onOpen({ id, session, isTest })
        if (!isTest) {
          saveSession('support.customer', session)
          try { currentAnalytics().track('support_case_created', {}) } catch { /* Tracking never changes a created case. */ }
        }
      }
      const result = await request<CustomerMessageResult>(`/chat/cases/${id}/messages`, session, { method: 'POST', customer: true, body: { body } })
      setAcceptedRun(result.runId && result.ownership !== 'staff' ? { id: result.runId, acceptedAt: Date.now() } : null)
      setDraft(''); setPendingBody(''); resource.refresh()
    } catch (cause) { setError(cause); resource.refresh() }
    finally { setBusy(false) }
  }
  const sendLabel = t('core.common.send')
  return <>
    <header className="customer-chat-header">
      <div className="customer-chat-identity">
        <span className="chat-brand-icon"><Icon name="chat" size={20} /></span>
        <div>
          <h2>{data?.businessName || demo?.businessName || t('core.chat.team')}</h2>
          {demo && <span className="small muted">{t('core.chat.demoNotice')}</span>}
        </div>
      </div>
      <div className="customer-chat-actions">
        {data && data.status !== 'open' && <Badge value={data.status} />}
        {conversation && <button type="button" className="customer-new-chat" onClick={onNew} disabled={readOnly || busy} aria-label={t('core.chat.new')} title={t('core.chat.new')}>
          <Icon name="plus" size={18} /><span>{t('core.chat.new')}</span>
        </button>}
      </div>
    </header>
    <MessageThread customer messages={data?.messages ?? []} customerName={t('core.chat.you')} loading={preparing || resource.loading} pending={pending} />
    {(resource.error || activeRun?.status === 'failed' || error !== null) && <div className="customer-chat-notices">
      {resource.error && <ErrorNotice error={resource.errorCause} />}
      {activeRun?.status === 'failed' && <Notice error>{t('core.chat.runFailed')}</Notice>}
      {error !== null && <ErrorNotice error={error}>{pendingBody && <p>{t('core.chat.savedText')}</p>}</ErrorNotice>}
    </div>}
    <form className="customer-composer" onSubmit={event => { event.preventDefault(); void send() }}>
      {!demo && !preparing && !conversation && <div className="customer-session-field">
        <label htmlFor="customer-session">{t('core.chat.sessionKey')}</label>
        <input id="customer-session" type="password" autoComplete="off" value={draftToken} onChange={event => setDraftToken(event.target.value)} disabled={readOnly || busy} required />
      </div>}
      <label htmlFor="customer-message" className="sr-only">{t('core.chat.message')}</label>
      <textarea ref={messageInput} id="customer-message" required maxLength={2000} disabled={readOnly || busy || processing} value={draft} onChange={event => setDraft(event.target.value)} placeholder={t('core.chat.placeholder')} />
      <button className="primary" disabled={!canSend} aria-label={sendLabel} title={sendLabel}>
        <Icon name="send" size={18} /><span>{sendLabel}</span>
      </button>
    </form>
  </>
}
