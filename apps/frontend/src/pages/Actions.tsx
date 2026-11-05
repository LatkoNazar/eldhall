import { useI18n, formatNumber, type AppMessageKey } from '../i18n'
import { ErrorNotice } from '../components/ErrorNotice'
import { AppLink } from '../components/AppLink'
import { useEffect, useRef, useState } from 'react'
import { Avatar, Badge, Empty, Icon, Metric, Notice } from '../components/ui'
import { dateTime, errorText, request } from '../lib/api'
import type { CaseDetail, Metrics, Proposal, ProposalStatus, SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { ActionCard } from '../components/ActionCard'
import { contextText } from '../lib/presentation'
import { actionEventLabel, proposalTitle } from '../lib/external-actions'

type Phase = 'pending' | 'running' | 'history'
interface ActionRow { proposal: Proposal; detail: CaseDetail; stale: boolean }
const phaseLabels: Record<Phase, AppMessageKey> = { pending: 'core.actions.pending', running: 'core.actions.running', history: 'core.actions.history' }
function phaseOf(status: ProposalStatus): Phase { return status === 'pending' || status === 'approved' ? 'pending' : status === 'executing' ? 'running' : 'history' }

function useActionRows(token: string, caseIds: string[]) {
  const { t } = useI18n()
  const key = caseIds.join(',')
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ rows: ActionRow[]; failed: number; errorCause: unknown; checkedAt: string | null; caseKey: string | null }>({ rows: [], failed: 0, errorCause: null, checkedAt: null, caseKey: null })
  useEffect(() => {
    const ids = key ? key.split(',') : []
    const controller = new AbortController()
    let active = true
    let timer = 0
    async function load() {
      let cursor = 0
      const loaded = new Map<string, CaseDetail>()
      const failed = new Set<string>()
      let errorCause: unknown = null
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (active && cursor < ids.length) {
          const id = ids[cursor++]!
          try { loaded.set(id, await request<CaseDetail>(`/cases/${encodeURIComponent(id)}`, token, { signal: controller.signal })) }
          catch (cause) { failed.add(id); errorCause = cause }
        }
      }))
      if (!active) return
      setState(previous => {
        const rows: ActionRow[] = []
        for (const id of ids) {
          const detail = loaded.get(id)
          if (detail) rows.push(...detail.proposals.map(proposal => ({ proposal, detail, stale: false })))
          else rows.push(...previous.rows.filter(row => row.detail.case.id === id).map(row => ({ ...row, stale: true })))
        }
        rows.sort((left, right) => right.proposal.createdAt.localeCompare(left.proposal.createdAt) || left.proposal.id.localeCompare(right.proposal.id))
        return { rows, failed: failed.size, errorCause, checkedAt: new Date().toISOString(), caseKey: key }
      })
      timer = window.setTimeout(() => void load(), 5000)
    }
    void load()
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [key, token, revision])
  return { ...state, error: state.errorCause ? errorText(state.errorCause, t) : '', loading: state.caseKey !== key, refresh: () => setRevision(value => value + 1) }
}

export function Actions({ token, cases, casesError, metrics, metricsError, search, onRefresh, businessNames = {} }: { businessNames?: Readonly<Record<string, string>>; token: string; cases: SupportCase[] | null; casesError: string; metrics: Metrics | null; metricsError: string; search: string; onRefresh: () => void }) {
  const { t, locale } = useI18n()
  const [limit, setLimit] = useState(50)
  const [phase, setPhase] = useState<Phase>('pending')
  const [selectedId, setSelectedId] = useState<string | null>()
  const [mobileDetail, setMobileDetail] = useState(false)
  const tableRegion = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<string | null>(null)
  const resource = useActionRows(token, (cases ?? []).slice(0, limit).map(item => item.id).sort())
  const query = search.trim().toLocaleLowerCase(locale)
  const matching = resource.rows.filter(row => `${row.detail.customer.name} ${row.proposal.id} ${row.detail.case.id} ${proposalTitle(row.proposal, t)}`.toLocaleLowerCase(locale).includes(query))
  const visible = matching.filter(row => phaseOf(row.proposal.status) === phase)
  const counts = { pending: matching.filter(row => phaseOf(row.proposal.status) === 'pending').length, running: matching.filter(row => phaseOf(row.proposal.status) === 'running').length, history: matching.filter(row => phaseOf(row.proposal.status) === 'history').length }
  const selected = selectedId === null ? undefined : resource.rows.find(row => row.proposal.id === selectedId) ?? (selectedId === undefined ? visible[0] : undefined)
  const loaded = cases !== null && !resource.loading
  const incomplete = (cases?.length ?? 0) > limit
  useEffect(() => {
    const actionId = restoreFocusRef.current
    if (actionId === null || mobileDetail) return
    restoreFocusRef.current = null
    const buttons = tableRegion.current?.querySelectorAll<HTMLButtonElement>('button[data-action-id]')
    const rowButton = buttons && Array.from(buttons).find(button => button.dataset.actionId === actionId)
    ;(rowButton ?? tableRegion.current)?.focus()
  }, [mobileDetail, selectedId])
  function refresh() { resource.refresh(); onRefresh() }
  function changePhase(next: Phase) { setPhase(next); setSelectedId(undefined); setMobileDetail(false) }
  function closeInspector() { restoreFocusRef.current = selected?.proposal.id ?? ''; setMobileDetail(false); setSelectedId(null) }
  return <div className={`actions-page-grid ${mobileDetail ? 'actions-mobile-open' : ''}`}>
    <div className="actions-main" tabIndex={0} role="region" aria-label={t("core.actions.list")}>
      <div className="page-heading"><div><h1>{t("core.nav.actions")}</h1><p>{t("core.actions.subtitle")}</p></div><button onClick={refresh}><Icon name="refresh" />{t("core.common.refresh")}</button></div>
      <div className="metrics-grid compact-metrics actions-metrics">
        <Metric icon="clock" label={t("core.actions.awaitingSteps")} value={metrics ? (metrics.proposals.pending ?? 0) + (metrics.proposals.approved ?? 0) : '—'} />
        <Metric icon="spark" label={t("core.actions.running")} value={metrics?.proposals.executing ?? '—'} />
        <Metric icon="check" label={t("core.actions.allExecuted")} value={metrics?.proposals.executed ?? '—'} />
        <Metric icon="help" label={t("core.actions.errorsUnknown")} value={metrics ? (metrics.proposals.failed ?? 0) + (metrics.proposals.unknown ?? 0) : '—'} />
      </div>
      <p className="actions-scope-caption muted">{t("core.actions.metricsHint")}</p>
      {casesError && <Notice error>{casesError}  {t("core.actions.listStale")} <button onClick={refresh}>{t("core.actions.refresh")}</button></Notice>}
      {metricsError && <Notice error>{t("core.actions.metricsStale")} {metricsError}</Notice>}
      {resource.failed > 0 && <Notice error>{t("core.actions.failedPrefix")} {formatNumber(resource.failed, locale)}  {t("core.actions.failedSuffix")} {resource.error} <button onClick={refresh}>{t("core.common.retryRead")}</button></Notice>}
      <section className="card actions-table-card" ref={tableRegion} tabIndex={-1} aria-label={t("core.actions.list")}>
        <div className="tabs actions-tabs" aria-label={t("core.actions.phases")}>{(['pending', 'running', 'history'] as const).map(value => <button key={value} className={phase === value ? 'active' : ''} aria-pressed={phase === value} onClick={() => changePhase(value)}>{t(phaseLabels[value])} <span>{loaded ? formatNumber(counts[value], locale) : '—'}</span></button>)}</div>
        {visible.length ? <div className="table-scroll"><table className="actions-table"><caption className="sr-only">{t("core.actions.captionPrefix")} {t(phaseLabels[phase])}{t("core.actions.captionSuffix")}</caption><thead><tr><th scope="col">{t("core.common.customer")}</th><th scope="col">{t("core.actions.proposed")}</th><th scope="col">{t("presentation.contextColumn")}</th><th scope="col">{t("core.common.status")}</th><th scope="col">{t("core.common.time")}</th></tr></thead><tbody>{visible.map(row => <tr key={row.proposal.id} className={row.proposal.id === selected?.proposal.id ? 'selected-row' : ''}>
          <td><button className="action-row-select" data-action-id={row.proposal.id} aria-label={t('core.actions.openLabel', { title: proposalTitle(row.proposal, t), name: row.detail.customer.name, id: row.proposal.id })} aria-pressed={row.proposal.id === selected?.proposal.id} onClick={() => { setSelectedId(row.proposal.id); setMobileDetail(true) }}><Avatar name={row.detail.customer.name} seed={`${row.detail.customer.businessId}:${row.detail.customer.id}`} /><span><strong>{row.detail.customer.name}</strong><small>#{row.proposal.id.slice(0, 8)}</small></span></button></td>
          <td><strong>{proposalTitle(row.proposal, t)}</strong><small>{row.proposal.risk === 'high' ? t("core.action.highRisk") : t("core.action.lowRisk")}{row.stale ? " " + t("core.actions.staleSuffix") + "" : ''}</small></td>
          <td className="action-table-context">{contextText(row.proposal, row.detail, t, locale)}</td><td><Badge value={row.proposal.status} /></td><td><time dateTime={row.proposal.createdAt} title={`${dateTime(row.proposal.createdAt, locale)} ${t('core.common.kyiv')}`}>{dateTime(row.proposal.createdAt, locale)}</time></td>
        </tr>)}</tbody></table></div> : <Empty icon="spark" title={!loaded ? t("core.actions.loading") : resource.failed ? t("core.actions.partial") : query ? t("core.actions.noMatches") : phase === 'pending' ? t("core.actions.noPending") : phase === 'running' ? t("core.actions.noRunning") : t("core.actions.noHistory")}>{loaded && !query && !resource.failed ? t("core.actions.noProposalHint") : t("core.actions.searchHint")}</Empty>}
        <div className="actions-table-footer"><span>{loaded ? t('core.actions.tabCount', { count: visible.length }) : t("core.common.awaitingData")}{resource.checkedAt && ` · ${t('core.common.updated', { time: dateTime(resource.checkedAt, locale) })}`}</span>{incomplete && <button onClick={() => setLimit(previous => previous + 50)}>{t("core.actions.loadMore")}</button>}</div>
      </section>
      {incomplete && <Notice>{t("core.actions.loadedPrefix")} {formatNumber(Math.min(limit, cases?.length ?? 0), locale)}  {t("core.common.of")} {cases?.length ?? 0}  {t("core.actions.loadedSuffix")}</Notice>}
    </div>
    {selected ? <ActionInspector key={selected.proposal.id} row={selected} token={token} businessName={businessNames[selected.detail.case.businessId]} stale={!!casesError || resource.loading} onChanged={() => { setSelectedId(selected.proposal.id); refresh() }} onClose={closeInspector} onShowPhase={next => { setPhase(next); setSelectedId(selected.proposal.id) }} phase={phase} /> : <aside className="card actions-inspector-empty"><Empty icon="spark" title={t("core.actions.select")}>{t("core.actions.selectHint")}</Empty></aside>}
  </div>
}

function ActionInspector({ row, token, stale, onChanged, onClose, onShowPhase, phase, businessName }: { businessName?: string; row: ActionRow; token: string; stale: boolean; onChanged: () => void; onClose: () => void; onShowPhase: (phase: Phase) => void; phase: Phase }) {
  const { t, locale } = useI18n()
  const resource = useResource<CaseDetail>(`/cases/${encodeURIComponent(row.detail.case.id)}`, token, 2500)
  const detail = resource.data ?? row.detail
  const proposal = detail.proposals.find(item => item.id === row.proposal.id)
  const events = detail.audit.filter(event => event.data.proposalId === row.proposal.id).slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return <aside className="card actions-inspector" aria-label={t("core.actions.detailsLabel")}>
    <div className="actions-inspector-header"><div className="customer-heading"><Avatar name={detail.customer.name} seed={`${detail.customer.businessId}:${detail.customer.id}`} /><div><h2>{detail.customer.name}</h2><span className="muted small">{detail.customer.email}</span><small>{t("core.actions.actionPrefix")}{row.proposal.id.slice(0, 8)}</small></div></div><button className="icon-button" aria-label={t("core.actions.closeDetails")} onClick={onClose}><Icon name="close" /></button></div>
    <div className="actions-inspector-label">{t("core.actions.details")}</div>
    <div className="actions-inspector-body" tabIndex={0} role="region" aria-label={t("core.actions.details")}>
      <dl className="facts action-case-context"><dt>{t("presentation.businessId")}</dt><dd>{businessName || detail.case.businessId}</dd><dt>{t("presentation.caseId")}</dt><dd>{detail.case.id}</dd></dl>
      {resource.error && <ErrorNotice error={resource.errorCause}>{t("core.common.stale")}<button onClick={resource.refresh}>{t("core.common.refresh")}</button></ErrorNotice>}
      {proposal ? <>
        {phaseOf(proposal.status) !== phase && <Notice>{t("core.actions.movedPrefix")}{t(phaseLabels[phaseOf(proposal.status)])}». <button onClick={() => onShowPhase(phaseOf(proposal.status))}>{t("core.actions.goToTab")}</button></Notice>}
        <div className={`action-policy-summary ${proposal.policy.allowed ? '' : 'action-policy-denied'}`}><Icon name={proposal.policy.allowed ? 'check' : 'lock'} /><div><strong>{proposal.policy.allowed ? t("core.actions.allowed") : t("core.audit.policyDenied")}</strong><p>{proposal.policy.requiresApproval ? t("core.actions.approvalSeparate") : t("core.actions.approvalNotRequired")}</p></div></div>
        <ActionCard compact proposal={proposal} detail={detail} token={token} stale={stale || row.stale || !!resource.error || resource.loading} onChanged={() => { resource.refresh(); onChanged() }} />
        <p className="actions-policy-source"><Icon name="lock" size={16} /><span>{t("core.actions.policyHint")}</span></p>
        {proposal.tool === 'refund_payment' && <p className="actions-simulation"><Badge value="draft">{t("core.actions.paymentSimulation")}</Badge><span>{t("core.actions.noMoney")}</span></p>}
        {proposal.decidedBy && <dl className="facts"><dt>{t("core.actions.decision")}</dt><dd>{proposal.decidedBy}</dd>{proposal.decidedAt && <><dt>{t("core.actions.decisionTime")}</dt><dd>{dateTime(proposal.decidedAt, locale)}</dd></>}</dl>}
      </> : <Notice error>{t("core.actions.unavailable")}</Notice>}
      <section className="actions-timeline"><h3>{t("core.actions.audit")}</h3>{events.length ? <ol className="timeline">{events.map(event => <li key={event.id}><strong>{actionEventLabel(event.type, t)}</strong><small>{event.actor} · {dateTime(event.createdAt, locale)}</small>{typeof event.data.reason === 'string' && <p>{event.data.reason}</p>}</li>)}</ol> : <p className="muted small">{t("core.actions.noAudit")}</p>}</section>
      <AppLink className="actions-case-link" href={`/operator?caseId=${encodeURIComponent(detail.case.id)}`}>{t("core.actions.openInbox")} <Icon name="arrow" size={16} /></AppLink>
    </div>
  </aside>
}
