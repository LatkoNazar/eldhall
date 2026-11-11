import { useI18n, formatTime, formatNumber, type UiMessage } from '../i18n'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { ErrorNotice } from '../components/ErrorNotice'
import { AppLink } from '../components/AppLink'
import { ActionCard } from '../components/ActionCard'
export { ActionCard } from '../components/ActionCard'
import { useEffect, useRef, useState } from 'react'
import { Avatar, Badge, Empty, Icon, Notice } from '../components/ui'
import { MessageThread, type MessageRequestLink } from '../components/MessageThread'
import { RequestInspector } from '../components/RequestInspector'
import { requestLabel } from '../lib/request-catalog'
import { dateTime, intentLabel, request } from '../lib/api'
import type { CaseDetail, CaseStatus, SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { registerNavigationGuard } from '../lib/navigation'

export function CaseWorkspace({ token, cases, search, actionOnly, testSessions = false, onChanged, onRefresh, businessNames = {} }: { token: string; cases: SupportCase[]; search: string; actionOnly: boolean; testSessions?: boolean; onChanged: () => void; onRefresh?: () => void; businessNames?: Readonly<Record<string, string>> }) {
  const { t, locale } = useI18n()
  const [linkedCase] = useState(() => new URLSearchParams(window.location.search).get('caseId') ?? '')
  const [selected, setSelected] = useState(linkedCase)
  const [status, setStatus] = useState<CaseStatus | ''>('')
  const [mobileDetail, setMobileDetail] = useState(Boolean(linkedCase && (!testSessions || cases.some(item => item.id === linkedCase))))
  const [panel, setPanel] = useState<'conversation' | 'inspector'>('conversation')
  const workspace = useRef<HTMLDivElement>(null)
  const wasDetail = useRef(false)
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 767px)').matches) {
      if (mobileDetail) workspace.current?.querySelector<HTMLButtonElement>('.workspace-panels button[aria-pressed="true"]')?.focus()
      else if (wasDetail.current) {
        const target = workspace.current?.querySelector<HTMLElement>('.case-item.selected') ?? workspace.current?.querySelector<HTMLElement>('.case-list')
        target?.focus()
      }
    }
    wasDetail.current = mobileDetail
  }, [mobileDetail])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const filtered = cases.filter(item => (!status || item.status === status) && `${item.customerName} ${item.intent ? intentLabel(item.intent, t) : ''} ${item.analysis?.classification?.label ?? ''}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)))
  const directLink = !testSessions && !!linkedCase && selected === linkedCase && !status && !search
  const activeId = filtered.some(item => item.id === selected) || directLink ? selected : filtered[0]?.id
  const openCase = (id: string) => { setSelected(id); setPanel('conversation'); setMobileDetail(true) }
  return <div className={`case-workspace ${mobileDetail ? 'case-workspace-detail' : ''}`} ref={workspace}>
    <div className="case-toolbar"><div className="tabs" aria-label={t("core.inbox.filter")}><button className={!status ? 'active' : ''} onClick={() => setStatus('')}>{t("core.common.all")} <span>{formatNumber(cases.length, locale)}</span></button>{(['open', 'awaiting_approval', 'escalated', 'resolved'] as const).map(value => <button className={status === value ? 'active' : ''} key={value} onClick={() => setStatus(value)}>{({ open: t("core.inbox.open"), awaiting_approval: t("core.inbox.awaiting"), escalated: t("core.inbox.escalated"), resolved: t("core.inbox.resolved") })[value]} <span>{formatNumber(cases.filter(item => item.status === value).length, locale)}</span></button>)}</div>{onRefresh && <button className="workspace-refresh" onClick={onRefresh}><Icon name="refresh" />{t("core.common.refresh")}</button>}</div>
    <div className="workspace-panels"><button className="workspace-queue-back" aria-label={t("core.inbox.back")} onClick={() => setMobileDetail(false)}><span aria-hidden="true">←</span>{t("core.inbox.queuePanel")}</button><button aria-pressed={panel === 'conversation'} onClick={() => setPanel('conversation')}>{t("core.inbox.conversationPanel")}</button><button aria-pressed={panel === 'inspector'} onClick={() => setPanel('inspector')}>{t("core.inbox.copilot")}</button></div>
    <div data-panel={panel} className={`inbox-layout ${actionOnly ? 'action-layout' : ''} ${mobileDetail ? 'mobile-detail-open' : ''}`}>
      <section className="case-list card" tabIndex={0} aria-label={t(testSessions ? 'core.chat.testSessions' : 'core.inbox.queue')}>
        <div className="list-caption">
          {testSessions ? <span>{t('core.chat.testSessions')}</span> : actionOnly && <span>{t('core.inbox.casesActions')}</span>}
          <small>{t('core.inbox.queueCount', { count: filtered.length })}</small>
        </div>
        {filtered.length ? filtered.map(item => {
          const active = item.id === activeId
          const className = active ? 'case-item selected' : 'case-item'
          const content = <>
            <Avatar name={item.customerName} seed={`${item.businessId}:${item.customerId}`} />
            <span className="case-item-body">
              <span className="case-item-heading"><strong>{item.customerName}</strong><small>{item.priority}</small></span>
              <span className="case-subject">{item.intent ? intentLabel(item.intent, t) : t('core.inbox.new')}</span>
              {item.analysis?.classification && <span className="case-preview">{t('core.inbox.classPrefix')} {item.analysis.classification.label}</span>}
              {item.analysis?.summary && <span className="case-preview">{item.analysis.summary}</span>}
              <span className="case-item-bottom">
                <Badge value={item.status} />
                <time dateTime={item.updatedAt} title={`${dateTime(item.updatedAt, locale)} ${t('core.common.kyiv')}`}>{formatTime(item.updatedAt, locale)}</time>
              </span>
            </span>
          </>
          return testSessions
            ? <AppLink key={item.id} className={className} href={`/operator?environment=test&caseId=${encodeURIComponent(item.id)}`} aria-current={active || undefined} onClick={event => {
              if (item.id === linkedCase && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) openCase(item.id)
            }}>{content}</AppLink>
            : <button key={item.id} className={className} type="button" aria-pressed={active} onClick={() => openCase(item.id)}>{content}</button>
        }) : <Empty title={t(cases.length ? 'core.inbox.noMatches' : testSessions ? 'core.chat.noTestSessions' : 'core.inbox.empty')}>
          {cases.length ? t('core.inbox.searchHint') : testSessions ? <AppLink href="/chat">{t('core.nav.testAgent')}</AppLink> : t('core.inbox.emptyHint')}
        </Empty>}
      </section>
      {activeId ? <CaseView key={activeId} id={activeId} token={token} businessName={businessNames[cases.find(item => item.id === activeId)?.businessId ?? '']} actionOnly={actionOnly} testSessions={testSessions} draft={drafts[activeId] ?? ''} onDraft={value => setDrafts(previous => ({ ...previous, [activeId]: value }))} onBack={() => setMobileDetail(false)} onInspectRequest={() => setPanel('inspector')} onShowConversation={() => setPanel('conversation')} onChanged={onChanged} /> : <section className="card case-placeholder"><Empty icon="spark" title={t("core.inbox.placeholderTitle")} /></section>}
    </div>
  </div>
}

function CaseView({ id, token, actionOnly, testSessions, draft, onDraft, onBack, onChanged, businessName, onInspectRequest, onShowConversation }: { onInspectRequest: () => void; onShowConversation: () => void; id: string; token: string; businessName?: string; actionOnly: boolean; testSessions: boolean; draft: string; onDraft: (draft: string) => void; onBack: () => void; onChanged: () => void }) {
  const { t, translateMessage } = useI18n()
  const resource = useResource<CaseDetail>(`/cases/${encodeURIComponent(id)}`, token, 3000)
  const setDraft = onDraft
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<UiMessage | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [contextExpanded, setContextExpanded] = useState(false)
  const [selectedRequest, setSelectedRequest] = useState<string | null>(null)
  const [sourceJump, setSourceJump] = useState<{ messageId: string; sequence: number } | null>(null)
  const detail = resource.data
  useEffect(() => {
    if (!draft) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    const removeGuard = registerNavigationGuard(() => window.confirm(t("core.inbox.discard")))
    window.addEventListener('beforeunload', warn)
    return () => { removeGuard(); window.removeEventListener('beforeunload', warn) }
  }, [draft, t])
  async function caseAction(action: string, body?: unknown) {
    if (isReadOnlyDemo() || !detail || busy) return
    setBusy(action); setError(null); setNotice(null)
    try {
      await request(`/cases/${id}/${action}`, token, { method: 'POST', body: { ownershipVersion: detail.case.ownershipVersion, ...typeof body === 'object' && body !== null ? body : {} } })
      if (action === 'messages') { setDraft(''); setNotice({ key: 'core.inbox.sent' }) }
      else setNotice({ key: action === 'takeover' ? 'core.inbox.takenOver' : action === 'resume-bot' ? 'core.inbox.resumed' : 'core.inbox.markedResolved' })
      resource.refresh(); onChanged()
    } catch (cause) { setError(cause); resource.refresh() }
    finally { setBusy('') }
  }
  if (!detail) return <section className="card"><Empty title={resource.loading ? t("core.thread.loading") : t("core.inbox.unavailable")} />{resource.error && <Notice error>{resource.error}<button onClick={resource.refresh}>{t("core.common.refresh")}</button></Notice>}</section>
  if ((detail.case.isTest === true) !== testSessions) return <section className="card conversation"><Empty title={t('core.inbox.unavailable')}>
    {detail.case.isTest && <AppLink href={`/operator?environment=test&caseId=${encodeURIComponent(id)}`}>{t('core.chat.testSessions')}</AppLink>}
  </Empty></section>
  const selectedRequestItem = detail.requestCatalog?.requests.find(item => item.id === selectedRequest)
  const messageRequestLinks: Record<string, MessageRequestLink[]> = {}
  for (const item of detail.requestCatalog?.requests ?? []) for (const messageId of item.sourceMessageIds) {
    ;(messageRequestLinks[messageId] ??= []).push({ id: item.id, label: requestLabel(item), title: item.title })
  }
  const selectRequest = (requestId: string | null) => { setSelectedRequest(requestId); if (requestId) onInspectRequest() }
  const showSource = (messageId: string) => { onShowConversation(); setSourceJump(previous => ({ messageId, sequence: (previous?.sequence ?? 0) + 1 })) }
  return <>
    <section className={`conversation card ${actionOnly ? 'actions-conversation' : ''}`} aria-label={t('core.inbox.conversationLabel', { name: detail.customer.name })}>
      <div className="conversation-header"><button className="mobile-back" onClick={onBack}>{t("core.inbox.back")}</button><div className="conversation-identity"><div className="customer-heading"><Avatar name={detail.customer.name} seed={`${detail.customer.businessId}:${detail.customer.id}`} /><div><h2>{detail.customer.name}</h2><span className="conversation-email muted small" data-expanded={contextExpanded}>{detail.customer.email}</span></div></div><button className="conversation-context-toggle" aria-expanded={contextExpanded} aria-controls={`case-controls-${id} case-meta-${id}`} onClick={() => setContextExpanded(value => !value)}>{t("core.inbox.context")}</button><div id={`case-controls-${id}`} className="case-controls" data-expanded={contextExpanded}>{detail.case.ownership !== 'staff' ? <button disabled={isReadOnlyDemo() || !!busy || !!resource.error} onClick={() => void caseAction('takeover')}><Icon name="team" size={17} />{t("core.inbox.takeover")}</button> : <button disabled={isReadOnlyDemo() || !!busy || !!resource.error} onClick={() => void caseAction('resume-bot')}><Icon name="spark" size={17} />{t("core.inbox.resume")}</button>}{detail.case.status !== 'resolved' && <button disabled={isReadOnlyDemo() || !!busy || !!resource.error} onClick={() => void caseAction('resolve')}>{t("core.inbox.resolve")}</button>}</div></div><div id={`case-meta-${id}`} className="conversation-meta" data-expanded={contextExpanded}><h3>{detail.case.intent ? intentLabel(detail.case.intent, t) : t("core.inbox.new")}</h3><div className="case-tags"><Badge value={detail.case.status} /><Badge value={detail.case.ownership ?? 'bot'} /><Badge value={detail.case.priority} /></div></div><div className="conversation-status" data-expanded={contextExpanded}><Badge value={detail.case.status} /></div></div>
      {resource.error && <Notice error>{t("core.common.stale")} {resource.error}</Notice>}
      {error !== null && <ErrorNotice error={error} />}{notice && <Notice>{translateMessage(notice)}</Notice>}
      {actionOnly ? <div className="actions-detail-scroll"><h3>{t("core.inbox.proposals")}</h3>{detail.proposals.length ? detail.proposals.map(proposal => <ActionCard compact key={proposal.id} proposal={proposal} detail={detail} token={token} stale={!!resource.error} onChanged={() => { resource.refresh(); onChanged() }} />) : <Empty icon="spark" title={t("core.inbox.noProposals")} />}</div> : <MessageThread messages={detail.messages} customerName={detail.customer.name} requestLinks={messageRequestLinks} selectedSourceIds={selectedRequestItem?.sourceMessageIds} onSelectRequest={selectRequest} sourceJump={sourceJump} />}
      {!actionOnly && <form className="composer" onSubmit={event => { event.preventDefault(); if (draft.trim()) void caseAction('messages', { body: draft.trim() }) }}>
        <label className="sr-only" htmlFor={`reply-${id}`}>{t('core.inbox.replyLabel')}</label>
        <textarea id={`reply-${id}`} rows={1} maxLength={2000}
          placeholder={t(detail.case.ownership === 'staff' ? 'core.inbox.replyLabel' : 'core.inbox.takeoverHint')}
          title={detail.case.ownership !== 'staff' ? t('core.inbox.takeoverHint') : undefined}
          disabled={isReadOnlyDemo() || detail.case.ownership !== 'staff' || !!busy || !!resource.error}
          value={draft} onChange={event => setDraft(event.target.value)} />
        <button className="primary" type="submit" disabled={isReadOnlyDemo() || !draft.trim() || !!busy || detail.case.ownership !== 'staff' || !!resource.error}>
          <Icon name="send" size={17} /><span>{busy === 'messages' ? t('core.common.sending') : t('core.common.send')}</span>
        </button>
      </form>}
    </section>
    <RequestInspector detail={detail} businessName={businessName} token={token} stale={!!resource.error} selectedId={selectedRequest} onSelect={selectRequest} onShowSource={showSource} renderActions={!actionOnly} onChanged={() => { resource.refresh(); onChanged() }} />
  </>
}
