import { WorkspaceProvider } from '../components/WorkspaceProvider'
import { useI18n, formatDateTime, formatNumber } from '../i18n'
import { ErrorNotice } from '../components/ErrorNotice'
import { AppLink } from '../components/AppLink'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Empty, Icon, Notice } from '../components/ui'
import { ApiError, UiError } from '../lib/api'
import { createInsightDraft, getInsightRun, listInsightRuns, startInsightRun } from '../lib/insights-api'
import type { InsightDraft, InsightFinding, InsightRun } from '../lib/insights-api'

interface Business { id: string; name: string; currency: string }
const active = (run: InsightRun) => run.status === 'queued' || run.status === 'running'
const statusLabels = { queued: "operations.insights.queued", running: "operations.insights.running", completed: "operations.insights.completed", failed: "operations.insights.failed" } as const
const findingLabels = { recurring_issue: "operations.insights.recurringIssue", knowledge_gap: "operations.insights.knowledgeGap", possible_contradiction: "operations.insights.contradiction" } as const

function useInsightRuns(businessId: string, token: string) {
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const [state, setState] = useState<{ runs: InsightRun[] | null; error: unknown | null; checkedAt: string | null; pollingPaused: boolean }>({ runs: null, error: null, checkedAt: null, pollingPaused: false })
  const refresh = useCallback(() => { generation.current++; setRevision(value => value + 1) }, [])
  const accept = useCallback((run: InsightRun) => {
    setState(previous => ({ ...previous, runs: [run, ...(previous.runs ?? []).filter(item => item.id !== run.id)], error: null, checkedAt: new Date().toISOString(), pollingPaused: false }))
    refresh()
  }, [refresh])
  useEffect(() => {
    const controller = new AbortController()
    const serial = generation.current
    const startedAt = Date.now()
    let mounted = true
    let timer = 0
    async function load() {
      let pending = false
      try {
        const runs = await listInsightRuns(businessId, token, controller.signal)
        if (!mounted || serial !== generation.current) return
        pending = runs.some(active)
        setState({ runs, error: null, checkedAt: new Date().toISOString(), pollingPaused: pending && Date.now() - startedAt >= 180_000 })
      } catch (cause) {
        if (mounted && serial === generation.current) setState(previous => ({ ...previous, error: cause }))
      } finally {
        if (mounted && serial === generation.current && pending && Date.now() - startedAt < 180_000) timer = window.setTimeout(() => void load(), 2500)
      }
    }
    void load()
    return () => { mounted = false; controller.abort(); window.clearTimeout(timer) }
  }, [businessId, token, revision])
  return { ...state, refresh, accept }
}

export function Insights({ token, embedded = false }: { token: string; embedded?: boolean }) {
  const { t } = useI18n()
  return <WorkspaceProvider token={token}>{business => <>
    {!embedded && <h1 className="sr-only">{t("operations.insights.title")}</h1>}
    <BusinessInsights key={business.id} business={business} token={token} scopeStale={false} />
  </>}</WorkspaceProvider>
}

function BusinessInsights({ business, token, scopeStale }: { business: Business; token: string; scopeStale: boolean }) {
  const { t, locale } = useI18n()
  const resource = useInsightRuns(business.id, token)
  const [selected, setSelected] = useState('')
  const [limit, setLimit] = useState(25)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
  const [pendingRequest, setPendingRequest] = useState<{ id: string; limit: number } | null>(null)
  const mutation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current?.abort() } }, [])
  const runs = resource.runs ?? []
  const run = runs.find(item => item.id === selected) ?? runs[0]
  const hasActiveRun = runs.some(active)
  async function analyze() {
    if (busyRef.current || resource.runs === null || resource.error || scopeStale || (hasActiveRun && !pendingRequest)) return
    busyRef.current = true; setBusy(true); setError(null)
    const pending = pendingRequest ?? { id: crypto.randomUUID(), limit }
    setPendingRequest(pending)
    mutation.current = new AbortController()
    try {
      const accepted = await startInsightRun(business.id, pending.limit, pending.id, token, mutation.current.signal)
      if (!mounted.current) return
      setPendingRequest(null)
      setSelected(accepted.id); resource.accept(accepted)
    } catch (cause) {
      if (!mounted.current) return
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) setPendingRequest(null)
      setError(cause); resource.refresh()
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const stale = scopeStale || !!resource.error
  return <>
    <section className="card padded insights-admission" aria-label={t("operations.insights.newAnalysis")}>
      <div><h2>{t("operations.insights.admissionTitle")}</h2><p className="muted">{t("operations.insights.manualOnly")}</p></div>
      <div className="insights-start-controls"><label htmlFor="insights-limit">{t("operations.insights.maximumCases")}</label><select id="insights-limit" value={limit} disabled={busy || !!pendingRequest} onChange={event => setLimit(Number(event.target.value))}>{[5, 10, 25].map(value => <option key={value} value={value}>{value}</option>)}</select><button className="primary" disabled={busy || resource.runs === null || stale || (hasActiveRun && !pendingRequest)} onClick={() => void analyze()}><Icon name="spark" size={17} />{busy ? t("operations.insights.accepting") : pendingRequest ? t("operations.insights.checkAccepted") : t("operations.insights.analyze")}</button></div>
      {hasActiveRun && <p className="small muted">{t("operations.insights.alreadyActive")}</p>}
      {Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}
      <p className="field-hint">{t("operations.insights.hypothesisWarning")}</p>
    </section>
    {Boolean(resource.error) && <ErrorNotice error={resource.error}>{t("operations.insights.staleResults")}  {t("operations.insights.refreshBeforeDraft")} <button onClick={resource.refresh}>{t("operations.insights.refreshResults")}</button></ErrorNotice>}
    {resource.pollingPaused && <Notice>{t("operations.insights.pollingPaused")} <button onClick={resource.refresh}>{t("operations.insights.checkStatus")}</button></Notice>}
    <div className="insights-run-toolbar"><label htmlFor="insights-run">{t("operations.insights.history")}</label><select id="insights-run" disabled={!runs.length} value={run?.id ?? ''} onChange={event => setSelected(event.target.value)}>{!runs.length && <option value="">{t("operations.insights.noRuns")}</option>}{runs.map(item => <option key={item.id} value={item.id}>{formatDateTime(item.createdAt, locale)} · {t(statusLabels[item.status])}</option>)}</select><button onClick={resource.refresh}><Icon name="refresh" size={17} />{t("operations.common.refresh")}</button>{resource.checkedAt && <small className="muted">{t("operations.insights.readAt")} {formatDateTime(resource.checkedAt, locale)}</small>}</div>
    {run ? <RunResult key={run.id} run={run} token={token} stale={stale} onRefresh={resource.refresh} onUpdated={resource.accept} /> : <section className="card"><Empty icon="chart" title={resource.runs === null && !resource.error ? t("operations.insights.loadingHistory") : t("operations.insights.notStarted")}>{t("operations.insights.emptyHistoryHint")}</Empty></section>}
  </>
}

function RunResult({ run, token, stale, onRefresh, onUpdated }: { run: InsightRun; token: string; stale: boolean; onRefresh: () => void; onUpdated: (run: InsightRun) => void }) {
  const { t, locale } = useI18n()
  const sample = run.sample
  const empty = run.status === 'completed' && sample.messageCount === 0
  const samplePending = active(run) && sample.messageCount === 0
  return <section className="insights-results" aria-label={t("operations.insights.result")}>
    <div className="card padded insights-sample"><div className="insights-result-heading"><h2>{t(statusLabels[run.status])}</h2><Badge value={run.status === 'failed' ? 'failed' : run.status === 'completed' ? 'ok' : 'pending'}>{t(statusLabels[run.status])}</Badge></div>
      <dl className="facts"><dt>{t("operations.insights.sampleCases")}</dt><dd>{samplePending ? t("operations.insights.forming") : t('operations.insights.sampleCount', { count: formatNumber(sample.caseCount, locale), total: formatNumber(sample.totalCases, locale) })}</dd><dt>{t("operations.insights.messages")}</dt><dd>{samplePending ? t("operations.insights.forming") : formatNumber(sample.messageCount, locale)}</dd><dt>{t("operations.insights.publishedSources")}</dt><dd>{samplePending ? t("operations.insights.forming") : t('operations.insights.sampleCount', { count: formatNumber(sample.knowledgeCount, locale), total: formatNumber(sample.totalPublishedKnowledge, locale) })}</dd><dt>{t("operations.insights.messagePeriod")}</dt><dd>{sample.from && sample.to ? `${formatDateTime(sample.from, locale)} — ${formatDateTime(sample.to, locale)}` : active(run) ? t("operations.insights.sampleForming") : t("operations.insights.noIncludedMessages")}</dd><dt>{active(run) ? t("operations.insights.plannedModel") : t("operations.insights.analysisModel")}</dt><dd className="break-word">{empty ? t("operations.insights.modelNotCalled") : `${run.provider} · ${run.model}`}</dd></dl>
      {sample.truncated ? <Notice>{t("operations.insights.limitedSample")}</Notice> : <p className="small muted">{t("operations.insights.snapshotHint")}</p>}
      {run.completedAt && <p className="small muted">{t("operations.insights.completed")} {formatDateTime(run.completedAt, locale)}</p>}
    </div>
    {active(run) && <Notice>{t("operations.insights.run")} {run.status === 'queued' ? t("operations.insights.waitingWorker") : t("operations.insights.processing")}{t("operations.insights.noDuplicateNeeded")}</Notice>}
    {run.error !== null && <ErrorNotice error={new ApiError(500, '', undefined, { key: 'operations.insights.failed' }, run.error)}></ErrorNotice>}
    {run.stale ? <Notice>{t("operations.insights.sourcesChanged")}</Notice> : run.status === 'completed' && <>
      {run.findings.length ? <><p className="insights-hypothesis-label"><Icon name="spark" size={18} />{t("operations.insights.reviewEach")}</p><div className="insights-findings">{run.findings.map(finding => <FindingCard key={finding.id} finding={finding} run={run} token={token} stale={stale} onRefresh={onRefresh} onUpdated={onUpdated} />)}</div></> : <div className="card"><Empty icon="book" title={empty ? t("operations.insights.noMessages") : t("operations.insights.noFindings")}>{empty ? t("operations.insights.addCases") : t("operations.insights.noFindingsHint")}</Empty></div>}
    </>}
  </section>
}

function FindingCard({ finding, run, token, stale, onRefresh, onUpdated }: { finding: InsightFinding; run: InsightRun; token: string; stale: boolean; onRefresh: () => void; onUpdated: (run: InsightRun) => void }) {
  const { t, locale } = useI18n()
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<unknown | null>(null)
  const [draft, setDraft] = useState<InsightDraft | null>(null)
  const draftId = draft?.id ?? finding.draftId
  const draftLink = useRef<HTMLAnchorElement | null>(null)
  const focusDraftLink = useRef(false)
  const mounted = useRef(true)
  const mutation = useRef<AbortController | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current?.abort() } }, [])
  useEffect(() => { if (draftId && focusDraftLink.current) { draftLink.current?.focus(); focusDraftLink.current = false } }, [draftId])
  async function createDraft() {
    if (busyRef.current || stale || run.stale || run.status !== 'completed' || !finding.proposedArticle) return
    busyRef.current = true; setBusy(true); setError(null); mutation.current = new AbortController()
    try {
      const fresh = await getInsightRun(run.businessId, run.id, token, mutation.current.signal)
      if (!mounted.current) return
      const current = fresh.findings.find(item => item.id === finding.id)
      if (fresh.stale || fresh.status !== 'completed' || !current?.proposedArticle) { onUpdated(fresh); throw new UiError("operations.insights.changedBeforeDraft") }
      if (current.draftId) { focusDraftLink.current = true; onUpdated(fresh); return }
      const created = await createInsightDraft(run.businessId, run.id, finding.id, token, mutation.current.signal)
      if (mounted.current) { focusDraftLink.current = true; setDraft(created); onRefresh() }
    } catch (cause) { if (mounted.current) { setError(cause); onRefresh() } }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return <article className="card padded insight-finding" aria-label={finding.title}>
    <div className="insights-finding-heading"><Badge value={finding.kind === 'possible_contradiction' ? 'pending' : undefined}>{t(findingLabels[finding.kind])}</Badge><span className="small muted">{t("operations.insights.sourcesPrefix")} {formatNumber(finding.caseCount, locale)} {t("operations.insights.caseAbbreviation")}</span></div>
    <h3 className="break-word">{finding.title}</h3><p className="break-word">{finding.summary}</p><h4>{t("operations.insights.whatToReview")}</h4><p className="break-word">{finding.recommendation}</p>
    <details className="insights-evidence"><summary>{t("operations.insights.evidenceSummary")}{formatNumber(finding.caseCount, locale)})</summary><ul>{finding.evidence.map(evidence => <li key={evidence.caseId}><AppLink href={`/operator?caseId=${encodeURIComponent(evidence.caseId)}`}>{t("operations.insights.openCasePrefix")}{evidence.caseId.slice(0, 8)}</AppLink><span className="small muted break-word">{t("operations.insights.messagesPrefix")} {evidence.messageIds.join(', ')}</span></li>)}</ul></details>
    {finding.knowledgeRefs.length > 0 && <details className="insights-evidence"><summary>{t("operations.insights.relatedKnowledge")}{formatNumber(finding.knowledgeRefs.length, locale)})</summary><ul>{finding.knowledgeRefs.map(source => <li key={source.id}><AppLink href={`/operator/knowledge?businessId=${encodeURIComponent(run.businessId)}&documentId=${encodeURIComponent(source.id)}`}>{t("operations.insights.documentPrefix")}{source.id.slice(0, 8)} · v{source.version}</AppLink></li>)}</ul></details>}
    {finding.proposedArticle && <details className="insights-proposal"><summary>{t("operations.insights.proposedText")}</summary><h4 className="break-word">{finding.proposedArticle.title}</h4><p className="insights-proposed-content">{finding.proposedArticle.content}</p><p className="field-hint">{t("operations.insights.reviewBeforePublish")}</p></details>}
    {Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}
    {draftId ? <Notice>{draft ? t('operations.insights.createdDraft', { title: draft.title }) : t("operations.insights.alreadyCreated")} <AppLink ref={draftLink} href={`/operator/knowledge?businessId=${encodeURIComponent(run.businessId)}&documentId=${encodeURIComponent(draftId)}`}>{t("operations.insights.openKnowledge")}</AppLink></Notice> : finding.proposedArticle && <button className="primary insights-draft-button" disabled={busy || stale || run.stale} onClick={() => void createDraft()}><Icon name="file" size={17} />{busy ? t("operations.insights.checkingDraft") : t("operations.insights.createDraft")}</button>}
  </article>
}
