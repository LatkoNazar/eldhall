import { AppLink } from '../components/AppLink'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Empty, Icon, Notice } from '../components/ui'
import { ApiError, dateTime, errorText } from '../lib/api'
import { createInsightDraft, getInsightRun, listInsightRuns, startInsightRun } from '../lib/insights-api'
import type { InsightDraft, InsightFinding, InsightRun } from '../lib/insights-api'
import { useResource } from '../lib/useResource'

interface Business { id: string; name: string; currency: string }
const active = (run: InsightRun) => run.status === 'queued' || run.status === 'running'
const statusLabels = { queued: 'У черзі', running: 'Аналізуємо', completed: 'Завершено', failed: 'Не вдалося завершити' }
const findingLabels = { recurring_issue: 'Повторювана проблема', knowledge_gap: 'Прогалина KB', possible_contradiction: 'Можлива суперечність' }

function useInsightRuns(businessId: string, token: string) {
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const [state, setState] = useState<{ runs: InsightRun[] | null; error: string; checkedAt: string | null; pollingPaused: boolean }>({ runs: null, error: '', checkedAt: null, pollingPaused: false })
  const refresh = useCallback(() => { generation.current++; setRevision(value => value + 1) }, [])
  const accept = useCallback((run: InsightRun) => {
    setState(previous => ({ ...previous, runs: [run, ...(previous.runs ?? []).filter(item => item.id !== run.id)], error: '', checkedAt: new Date().toISOString(), pollingPaused: false }))
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
        setState({ runs, error: '', checkedAt: new Date().toISOString(), pollingPaused: pending && Date.now() - startedAt >= 180_000 })
      } catch (cause) {
        if (mounted && serial === generation.current) setState(previous => ({ ...previous, error: errorText(cause) }))
      } finally {
        if (mounted && serial === generation.current && pending && Date.now() - startedAt < 180_000) timer = window.setTimeout(() => void load(), 2500)
      }
    }
    void load()
    return () => { mounted = false; controller.abort(); window.clearTimeout(timer) }
  }, [businessId, token, revision])
  return { ...state, refresh, accept }
}

export function Insights({ token }: { token: string }) {
  const resource = useResource<{ businesses: Business[] }>('/businesses', token)
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('businessId') ?? '')
  const businesses = resource.data?.businesses ?? []
  const business = businesses.find(item => item.id === selected) ?? businesses[0]
  return <>
    <div className="page-heading"><div><h1>Проблеми тікетів і KB</h1><p>Знаходьте повторювані запити та прогалини у знаннях на основі розмов.</p></div></div>
    {resource.error && <Notice error>{resource.error} <button onClick={resource.refresh}>Оновити бізнеси</button></Notice>}
    {business ? <><div className="business-scope"><label htmlFor="insights-business">Бізнес для аналізу</label><select id="insights-business" value={business.id} onChange={event => setSelected(event.target.value)}>{businesses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span className="muted small">Вибірка, джерела й результати належать лише цьому бізнесу.</span></div><BusinessInsights key={business.id} business={business} token={token} scopeStale={!!resource.error} /></> : <section className="card"><Empty icon="book" title={resource.loading ? 'Завантажуємо бізнеси…' : 'Немає доступного бізнесу'} /></section>}
  </>
}

function BusinessInsights({ business, token, scopeStale }: { business: Business; token: string; scopeStale: boolean }) {
  const resource = useInsightRuns(business.id, token)
  const [selected, setSelected] = useState('')
  const [limit, setLimit] = useState(25)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
    busyRef.current = true; setBusy(true); setError('')
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
      setError(errorText(cause)); resource.refresh()
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  const stale = scopeStale || !!resource.error
  return <>
    <section className="card padded insights-admission" aria-label="Новий аналіз тікетів">
      <div><h2>Що повторюється у зверненнях?</h2><p className="muted">AI перегляне останні звернення з повідомленнями та порівняє їх з опублікованою базою знань. Запуск лише вручну.</p></div>
      <div className="insights-start-controls"><label htmlFor="insights-limit">Максимум звернень</label><select id="insights-limit" value={limit} disabled={busy || !!pendingRequest} onChange={event => setLimit(Number(event.target.value))}>{[5, 10, 25].map(value => <option key={value} value={value}>{value}</option>)}</select><button className="primary" disabled={busy || resource.runs === null || stale || (hasActiveRun && !pendingRequest)} onClick={() => void analyze()}><Icon name="spark" size={17} />{busy ? 'Приймаємо запуск…' : pendingRequest ? 'Перевірити прийнятий запуск' : 'Аналізувати тікети'}</button></div>
      {hasActiveRun && <p className="small muted">Для цього бізнесу вже є активний аналіз. Worker збере вибірку та збереже результат.</p>}
      {error && <Notice error>{error}</Notice>}
      <p className="field-hint">Результати — гіпотези AI для перевірки. Публікація знань, зміна правил і дії з клієнтськими даними не виконуються автоматично.</p>
    </section>
    {resource.error && <Notice error>Результати можуть бути застарілими. {resource.error} Створення чернеток заблоковано до успішного оновлення. <button onClick={resource.refresh}>Оновити результати</button></Notice>}
    {resource.pollingPaused && <Notice>Автоматичне оновлення призупинено. Це не означає помилку запуску. <button onClick={resource.refresh}>Перевірити стан</button></Notice>}
    <div className="insights-run-toolbar"><label htmlFor="insights-run">Історія аналізу</label><select id="insights-run" disabled={!runs.length} value={run?.id ?? ''} onChange={event => setSelected(event.target.value)}>{!runs.length && <option value="">Немає запусків</option>}{runs.map(item => <option key={item.id} value={item.id}>{dateTime(item.createdAt)} · {statusLabels[item.status]}</option>)}</select><button onClick={resource.refresh}><Icon name="refresh" size={17} />Оновити</button>{resource.checkedAt && <small className="muted">Прочитано {dateTime(resource.checkedAt)}</small>}</div>
    {run ? <RunResult key={run.id} run={run} token={token} stale={stale} onRefresh={resource.refresh} onUpdated={resource.accept} /> : <section className="card"><Empty icon="chart" title={resource.runs === null && !resource.error ? 'Завантажуємо історію…' : 'Аналіз ще не запускався'}>Після ручного запуску тут з’являться вибірка, джерела та пропозиції для бази знань.</Empty></section>}
  </>
}

function RunResult({ run, token, stale, onRefresh, onUpdated }: { run: InsightRun; token: string; stale: boolean; onRefresh: () => void; onUpdated: (run: InsightRun) => void }) {
  const sample = run.sample
  const empty = run.status === 'completed' && sample.messageCount === 0
  const samplePending = active(run) && sample.messageCount === 0
  return <section className="insights-results" aria-label="Результат аналізу тікетів">
    <div className="card padded insights-sample"><div className="insights-result-heading"><h2>{statusLabels[run.status]}</h2><Badge value={run.status === 'failed' ? 'failed' : run.status === 'completed' ? 'ok' : 'pending'}>{statusLabels[run.status]}</Badge></div>
      <dl className="facts"><dt>Звернення у вибірці</dt><dd>{samplePending ? 'Ще формується' : `${sample.caseCount} з ${sample.totalCases}`}</dd><dt>Повідомлення</dt><dd>{samplePending ? 'Ще формується' : sample.messageCount}</dd><dt>Опубліковані джерела KB</dt><dd>{samplePending ? 'Ще формується' : `${sample.knowledgeCount} з ${sample.totalPublishedKnowledge}`}</dd><dt>Період повідомлень</dt><dd>{sample.from && sample.to ? `${dateTime(sample.from)} — ${dateTime(sample.to)}` : active(run) ? 'Вибірка ще формується' : 'Немає включених повідомлень'}</dd><dt>{active(run) ? 'Запланована модель' : 'Модель аналізу'}</dt><dd className="break-word">{empty ? 'Не викликалася: порожня вибірка' : `${run.provider} · ${run.model}`}</dd></dl>
      {sample.truncated ? <Notice>Проаналізовано обмежену вибірку. Висновки стосуються лише включених звернень і джерел, а не всіх клієнтів бізнесу.</Notice> : <p className="small muted">Кількості описують зафіксовану вибірку цього запуску. Нові повідомлення після формування цього зрізу до нього не входять.</p>}
      {run.completedAt && <p className="small muted">Завершено {dateTime(run.completedAt)}</p>}
    </div>
    {active(run) && <Notice>Запуск {run.status === 'queued' ? 'чекає worker' : 'обробляється'}. Повторне створення запуску не потрібне.</Notice>}
    {run.error && <Notice error>{run.error}</Notice>}
    {run.stale ? <Notice>Джерела KB змінилися або були відкликані. Попередні пропозиції приховано. Запустіть новий аналіз перед створенням чернеток.</Notice> : run.status === 'completed' && <>
      {run.findings.length ? <><p className="insights-hypothesis-label"><Icon name="spark" size={18} />Гіпотези AI · кожна потребує перевірки оператором</p><div className="insights-findings">{run.findings.map(finding => <FindingCard key={finding.id} finding={finding} run={run} token={token} stale={stale} onRefresh={onRefresh} onUpdated={onUpdated} />)}</div></> : <div className="card"><Empty icon="book" title={empty ? 'Немає повідомлень для аналізу' : 'У цій вибірці немає пропозицій'}>{empty ? 'Модель не викликалася. Додайте справжні звернення та запустіть аналіз знову.' : 'AI не повернув обґрунтованих висновків. Це не гарантує відсутність проблем поза цією вибіркою.'}</Empty></div>}
    </>}
  </section>
}

function FindingCard({ finding, run, token, stale, onRefresh, onUpdated }: { finding: InsightFinding; run: InsightRun; token: string; stale: boolean; onRefresh: () => void; onUpdated: (run: InsightRun) => void }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
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
    busyRef.current = true; setBusy(true); setError(''); mutation.current = new AbortController()
    try {
      const fresh = await getInsightRun(run.businessId, run.id, token, mutation.current.signal)
      if (!mounted.current) return
      const current = fresh.findings.find(item => item.id === finding.id)
      if (fresh.stale || fresh.status !== 'completed' || !current?.proposedArticle) { onUpdated(fresh); throw new Error('Джерела або стан змінилися. Перегляньте актуальний результат.') }
      if (current.draftId) { focusDraftLink.current = true; onUpdated(fresh); return }
      const created = await createInsightDraft(run.businessId, run.id, finding.id, token, mutation.current.signal)
      if (mounted.current) { focusDraftLink.current = true; setDraft(created); onRefresh() }
    } catch (cause) { if (mounted.current) { setError(errorText(cause)); onRefresh() } }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return <article className="card padded insight-finding" aria-label={finding.title}>
    <div className="insights-finding-heading"><Badge value={finding.kind === 'possible_contradiction' ? 'pending' : undefined}>{findingLabels[finding.kind]}</Badge><span className="small muted">Джерела: {finding.caseCount} зверн.</span></div>
    <h3 className="break-word">{finding.title}</h3><p className="break-word">{finding.summary}</p><h4>Що перевірити</h4><p className="break-word">{finding.recommendation}</p>
    <details className="insights-evidence"><summary>Звернення та повідомлення-джерела ({finding.caseCount})</summary><ul>{finding.evidence.map(evidence => <li key={evidence.caseId}><AppLink href={`/operator?caseId=${encodeURIComponent(evidence.caseId)}`}>Відкрити звернення #{evidence.caseId.slice(0, 8)}</AppLink><span className="small muted break-word">Повідомлення: {evidence.messageIds.join(', ')}</span></li>)}</ul></details>
    {finding.knowledgeRefs.length > 0 && <details className="insights-evidence"><summary>Пов’язані джерела KB ({finding.knowledgeRefs.length})</summary><ul>{finding.knowledgeRefs.map(source => <li key={source.id}><AppLink href={`/operator/knowledge?businessId=${encodeURIComponent(run.businessId)}&documentId=${encodeURIComponent(source.id)}`}>Документ #{source.id.slice(0, 8)} · v{source.version}</AppLink></li>)}</ul></details>}
    {finding.proposedArticle && <details className="insights-proposal"><summary>Запропонований текст для KB</summary><h4 className="break-word">{finding.proposedArticle.title}</h4><p className="insights-proposed-content">{finding.proposedArticle.content}</p><p className="field-hint">Перевірте факти та правила бізнесу перед публікацією.</p></details>}
    {error && <Notice error>{error}</Notice>}
    {draftId ? <Notice>{draft ? `Створено чернетку «${draft.title}».` : 'Документ для цієї пропозиції вже створений.'} <AppLink ref={draftLink} href={`/operator/knowledge?businessId=${encodeURIComponent(run.businessId)}&documentId=${encodeURIComponent(draftId)}`}>Відкрити документ KB</AppLink></Notice> : finding.proposedArticle && <button className="primary insights-draft-button" disabled={busy || stale || run.stale} onClick={() => void createDraft()}><Icon name="file" size={17} />{busy ? 'Перевіряємо та створюємо…' : 'Створити чернетку KB'}</button>}
  </article>
}
