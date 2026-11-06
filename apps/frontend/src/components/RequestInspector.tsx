import { useEffect, useRef, useState } from 'react'
import { useI18n, formatDateTime, formatNumber } from '../i18n'
import type { CaseDetail } from '../lib/api'
import { money } from '../lib/api'
import { relatedPayments } from '../lib/presentation'
import { currentRequestProposals, requestLabel, requestNeedsVerification, requestProposals, waitingDependencies, type CustomerRequest, type RequestCatalog } from '../lib/request-catalog'
import { ActionCard } from './ActionCard'
import { ClassificationSummary } from './ClassificationSummary'
import { AgentActivity } from './AgentActivity'
import { RequestTransitionForm } from './RequestTransitionForm'
import { Badge, Icon, Notice } from './ui'

export function RequestInspector({ detail, businessName, token, stale, selectedId, onSelect, onShowSource, onChanged, renderActions = true }: { detail: CaseDetail; businessName?: string; token: string; stale: boolean; selectedId: string | null; onSelect: (id: string | null) => void; onShowSource: (id: string) => void; onChanged: () => void; renderActions?: boolean }) {
  const { t, locale } = useI18n()
  const catalog = detail.requestCatalog
  const requests = catalog?.requests ?? []
  const selected = requests.find(item => item.id === selectedId)
  const [showAllActions, setShowAllActions] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const cards = useRef(new Map<string, HTMLButtonElement>())
  const previousSelection = useRef(selectedId)
  useEffect(() => {
    if (previousSelection.current === selectedId) return
    const previous = previousSelection.current
    previousSelection.current = selectedId
    if (selectedId) heading.current?.focus({ preventScroll: true })
    else if (previous) cards.current.get(previous)?.focus({ preventScroll: true })
  }, [selectedId])
  const linkedIds = new Set(requests.flatMap(item => item.actions.map(link => link.proposalId)))
  const unassigned = detail.proposals.filter(proposal => !linkedIds.has(proposal.id))
  const visibleActions = new Set(selected ? selected.actions.map(link => link.proposalId) : (!requests.length || showAllActions) ? detail.proposals.map(proposal => proposal.id) : [])
  const currentPayments = selected ? relatedPayments({ ...detail, proposals: requestProposals(selected, detail) }) : []
  const processing = detail.activeRun && ['queued', 'running'].includes(detail.activeRun.status)
  return <aside className="inspector request-inspector card" aria-label={t('core.inbox.inspector')}>
    <header className="request-inspector-header">
      {selectedId && <button type="button" className="request-back" onClick={() => onSelect(null)}><Icon name="arrow" size={16} />{t('requests.back')}</button>}
      <span className="eyebrow">{businessName || detail.case.businessId}</span>
      <h2 ref={heading} tabIndex={-1}>{selected ? selected.title : t('requests.catalog')}</h2>
      {selected ? <><span className="request-number">{requestLabel(selected)}</span><RequestState item={selected} catalog={catalog!} detail={detail} /></> : <p>{t('requests.count', { count: requests.length })}</p>}
      {processing && <p role="status" className="small"><Icon name="loading" size={15} />{t('requests.processing')}</p>}
      {catalog?.syncState === 'needs_review' && <Notice>{t('requests.review')}</Notice>}
    </header>
    <div className="request-inspector-body" tabIndex={0} role="region" aria-label={t('requests.catalog')}>
      <div hidden={selectedId !== null}>
        {!requests.length && <p className="muted">{t('requests.noRequests')}</p>}
        <div className="request-catalog">{requests.slice().sort((left, right) => left.number - right.number).map(item => <button type="button" className="request-catalog-card" key={item.id} data-request-id={item.id} ref={node => { if (node) cards.current.set(item.id, node); else cards.current.delete(item.id) }} aria-label={t('requests.open', { number: requestLabel(item), title: item.title })} onClick={() => onSelect(item.id)}>
          <span className="request-card-top"><span className="request-number">{requestLabel(item)}</span><RequestState item={item} catalog={catalog!} detail={detail} /></span>
          <strong><Icon name="file" size={18} />{item.title}</strong>
          <span className="small muted">{t('requests.next')}</span><span>{item.nextStep || t('requests.noNext')}</span>
          <span className="small">{t('requests.actions')} · {formatNumber(item.actions.length, locale)}</span>
          <span className="small muted">{t('requests.updated', { time: formatDateTime(item.updatedAt, locale), revision: item.revision })}</span>
        </button>)}</div>
        {(!requests.length || unassigned.length > 0) && <p className="small muted">{t('requests.legacy')}</p>}
        {requests.length > 0 && detail.proposals.length > 0 && <button type="button" aria-pressed={showAllActions} onClick={() => setShowAllActions(value => !value)}>{t('requests.allActions')}</button>}
      </div>
      {selectedId && !selected && <Notice>{t('requests.unavailable')}</Notice>}
      {selected && catalog && <>
        <section className="request-section"><h3>{t('requests.goal')}</h3><p>{selected.goal}</p><h4>{t('requests.next')}</h4><p>{selected.nextStep || t('requests.noNext')}</p><p className="small muted">{t('requests.updated', { time: formatDateTime(selected.updatedAt, locale), revision: selected.revision })} · {t('requests.by', { actor: selected.updatedBy })}</p></section>
        {selected.dependencyIds.length > 0 && <section className="request-section"><h3>{t('requests.dependencies')}</h3>{catalog.requests.filter(item => selected.dependencyIds.includes(item.id)).map(item => <button type="button" key={item.id} onClick={() => onSelect(item.id)}>{requestLabel(item)} · {item.title}<RequestState item={item} catalog={catalog} detail={detail} /></button>)}</section>}
        <section className="request-section"><h3><Icon name="mail" size={17} />{t('requests.sources')}</h3>{detail.messages.filter(message => selected.sourceMessageIds.includes(message.id)).map(message => <div className="request-source" key={message.id}><time dateTime={message.createdAt}>{formatDateTime(message.createdAt, locale)}</time><blockquote>{message.body.length > 240 ? `${message.body.slice(0, 240)}…` : message.body}</blockquote><button type="button" onClick={() => onShowSource(message.id)}>{t('requests.showSource')}<Icon name="arrow" size={15} /></button></div>)}</section>
        {currentPayments.length > 0 && <section className="request-section"><h3>{t('requests.relatedPayments')}</h3>{currentPayments.map(payment => <div className="payment-row" key={payment.id}><div><strong>{money(payment.amountCents, payment.currency, locale)}</strong><small>{payment.description}</small></div><Badge value={payment.status} /></div>)}</section>}
        <section className="request-section"><h3><Icon name="lock" size={17} />{t('requests.actions')}</h3>{!selected.actions.length && <p className="muted small">{t('requests.noActions')}</p>}<p className="field-hint">{t('requests.separate')}</p></section>
      </>}
      {!selectedId && (!requests.length || showAllActions) && <h3>{t(showAllActions && requests.length ? 'presentation.proposals' : 'requests.unassigned')}</h3>}
      {/* A proposal always has one stable host. Catalog/back/shared-request switches only hide it. */}
      <div className="request-action-host">{renderActions && detail.proposals.map(proposal => <div key={proposal.id} data-proposal-host={proposal.id} hidden={!visibleActions.has(proposal.id)}>
        {selected && selected.actions.find(link => link.proposalId === proposal.id)?.requestRevision !== undefined && selected.actions.find(link => link.proposalId === proposal.id)!.requestRevision !== selected.revision && <Notice>{t('requests.oldAction', { revision: selected.actions.find(link => link.proposalId === proposal.id)!.requestRevision })}</Notice>}
        <ActionCard compact proposal={proposal} detail={detail} token={token} stale={stale} onChanged={onChanged} />
      </div>)}</div>
      {catalog && requests.map(item => <div key={item.id} hidden={selectedId !== item.id}><RequestTransitionForm item={item} catalog={catalog} detail={detail} token={token} stale={stale} onChanged={onChanged} /></div>)}
      {selected && catalog && <>
        {selected.fulfillment && <section className="request-section"><h3>{t('requests.fulfillment')}</h3><p>{selected.fulfillment.reason}</p><small>{selected.fulfillment.actor} · {formatDateTime(selected.fulfillment.at, locale)}</small>{detail.messages.filter(message => selected.fulfillment!.proof.messageIds.includes(message.id)).map(message => <button type="button" key={message.id} onClick={() => onShowSource(message.id)}>{t('requests.proofMessage', { body: message.body.slice(0, 200) })}<Icon name="arrow" size={15} /></button>)}{detail.proposals.filter(proposal => selected.fulfillment!.proof.proposalIds.includes(proposal.id)).map(proposal => <p className="small" key={proposal.id}>{proposal.args.title && typeof proposal.args.title === 'string' ? proposal.args.title : proposal.tool} <Badge value={proposal.status} /></p>)}</section>}
        <section className="request-section"><h3><Icon name="clock" size={17} />{t('requests.history')}</h3><ol className="timeline">{catalog.history.events.filter(event => event.requestId === selected.id).slice().reverse().map(event => <li key={event.id}><strong>{t(`requests.event.${event.type}`)}</strong><small>{event.actor} · {formatDateTime(event.at, locale)} · {formatNumber(event.revision, locale)}</small>{event.reason && <p>{event.reason}</p>}<details><summary>{t('requests.goal')}</summary><p>{event.snapshot.goal}</p></details></li>)}</ol>{!catalog.history.events.some(event => event.requestId === selected.id) && <p>{t('requests.noHistory')}</p>}{catalog.history.hasMore && <p className="field-hint">{t('requests.historyMore')}</p>}</section>
      </>}
      {detail.case.analysis && <details className="request-ticket-context" open={!requests.length}><summary>{t('presentation.caseContext')}</summary><h3>{t('core.inbox.summary')}</h3><p>{detail.case.analysis.summary}</p><p>{detail.case.analysis.reasoning}</p>{detail.case.analysis.classification && <ClassificationSummary classification={detail.case.analysis.classification} />}</details>}
      <AgentActivity detail={detail} selectedRequestId={selectedId} />
      <p className="request-lifecycle-note"><Icon name="lock" size={15} />{t('requests.separate')}</p>
    </div>
  </aside>
}
function RequestState({ item, catalog, detail }: { item: CustomerRequest; catalog: RequestCatalog; detail: CaseDetail }) {
  const { t } = useI18n()
  const actions = currentRequestProposals(item, detail)
  const key = requestNeedsVerification(item, detail) ? 'requests.needsVerification' : item.lifecycle !== 'open' ? `requests.lifecycle.${item.lifecycle}` as const : waitingDependencies(item, catalog).length ? 'requests.blocked' : actions.some(proposal => proposal.status === 'pending' && proposal.policy.requiresApproval) ? 'core.status.awaiting_approval' : actions.some(proposal => proposal.status === 'approved') ? 'core.status.approved' : item.waitingOn ? `requests.waiting.${item.waitingOn}` as const : 'requests.lifecycle.open'
  return <span className={`badge request-state request-state-${item.lifecycle}`}>{t(key)}</span>
}
