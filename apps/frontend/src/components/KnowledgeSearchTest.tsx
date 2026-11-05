import { useI18n, formatNumber, type UiMessage } from '../i18n'
import { ErrorNotice } from './ErrorNotice'
import { useEffect, useState } from 'react'
import { Badge, Icon, Notice } from './ui'
import { request, UiError } from '../lib/api'
import { isKnowledgeIndex, isKnowledgeSearchResult } from '../lib/knowledge-search'
import type { KnowledgeIndex, KnowledgeSearchResult } from '../lib/knowledge-search'
export type { KnowledgePassage, KnowledgeHit, KnowledgeIndex, KnowledgeSearchResult } from '../lib/knowledge-search'

/** Lets an operator ask a customer question and see exactly which published passages the AI would receive. */
export function KnowledgeSearchTest({ token, businessId }: { token: string; businessId: string }) {
  const { t, locale, translateMessage } = useI18n()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null)
  const [audience, setAudience] = useState<'customer' | 'any'>('customer')
  const [plan, setPlan] = useState('')
  const [index, setIndex] = useState<KnowledgeIndex | null>(null)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState<UiMessage | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    request<unknown>(`/knowledge/index?businessId=${encodeURIComponent(businessId)}`, token, { signal: controller.signal })
      .then(value => setIndex(isKnowledgeIndex(value) ? value : null))
      .catch(() => setIndex(null))
    return () => controller.abort()
  }, [token, businessId, revision])

  async function reindex() {
    setBusy(true)
    setError(null)
    try {
      const done = await request<{ documents: number; chunks: number }>(`/knowledge/reindex?businessId=${encodeURIComponent(businessId)}`, token, { method: 'POST', body: {} })
      setNotice({ key: 'operations.knowledge.reindexed', values: { documents: done.documents, chunks: done.chunks } })
      setRevision(value => value + 1)
    } catch (cause) { setError(cause) } finally { setBusy(false) }
  }

  async function run() {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setError(null)
    try {
      const value = await request<unknown>(`/knowledge/search?businessId=${encodeURIComponent(businessId)}&q=${encodeURIComponent(q)}&k=5&audience=${audience}${plan.trim() ? `&plan=${encodeURIComponent(plan.trim())}` : ''}`, token)
      if (!isKnowledgeSearchResult(value)) throw new UiError("operations.knowledge.unexpectedResponse")
      setResult(value)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return <section className="card padded" aria-labelledby="kb-search-test-title">
    <h2 id="kb-search-test-title">{t("operations.knowledge.searchTest")}</h2>
    <p className="muted">{index?.readOnly ? t("operations.knowledge.externalSearchHint") : t("operations.knowledge.localSearchHint")}</p>
    {index?.readOnly && <Notice>{t("operations.knowledge.qdrantConfigured")} {index.collection}{t("operations.knowledge.externalReadOnly")}</Notice>}
    {index && <p className="inline-meta"><span>{t("operations.knowledge.index")} {index.vectorStore === 'qdrant' ? t("operations.knowledge.externalQdrant") : index.vectorStore === 'pgvector' ? 'PostgreSQL + pgvector' : t("operations.runtime.memory")}</span><span>{index.embedder.id}</span>{!index.readOnly && <><span>{t("operations.knowledge.chunks")} {index.chunks === null ? '—' : formatNumber(index.chunks, locale)}{index.staleChunks ? t('operations.knowledge.staleChunks', { count: index.staleChunks }) : ''}</span><button type="button" disabled={busy} onClick={() => void reindex()}>{t("operations.knowledge.reindex")}</button></>}</p>}
    {notice && <Notice>{translateMessage(notice)}</Notice>}
    <form className="resource-toolbar" style={{ padding: 0 }} onSubmit={event => { event.preventDefault(); void run() }}>
      <label className="search-field"><Icon name="search" /><input aria-label={t("operations.knowledge.customerQuestion")} placeholder={t("operations.knowledge.questionPlaceholder")} maxLength={500} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label={t("operations.knowledge.searchAudience")} disabled={index?.readOnly} value={index?.readOnly ? 'customer' : audience} onChange={event => setAudience(event.target.value === 'any' ? 'any' : 'customer')}><option value="customer">{t("operations.knowledge.asCustomer")}</option><option value="any">{t("operations.knowledge.asTeam")}</option></select>
      <input aria-label={t("operations.knowledge.customerPlan")} placeholder={t("operations.knowledge.planPlaceholder")} maxLength={80} value={plan} onChange={event => setPlan(event.target.value)} style={{ maxWidth: 200 }} />
      <button type="submit" className="primary" disabled={busy || !query.trim()}>{busy ? t("operations.knowledge.searching") : t("operations.knowledge.check")}</button>
    </form>
    {Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}
    {result && <div aria-live="polite">
      <p className="inline-meta" style={{ marginTop: 12 }}>{result.hits.length ? t('operations.knowledge.foundSources', { count: result.hits.length }) : t("operations.knowledge.noSearchResults")} · {result.mode === 'hybrid' ? t('operations.runtime.hybrid') : result.mode === 'lexical' ? t('operations.runtime.lexical') : result.mode === 'external' ? t('operations.knowledge.externalMode') : result.mode} · {result.embedder} · {formatNumber(result.tookMs, locale)} {t("operations.common.milliseconds")}</p>
      <ol>{result.hits.map(hit => <li key={hit.id} className="skill-item">
        <strong className="break-word">{hit.title}</strong> {result.mode !== 'external' && <Badge>v{hit.version}</Badge>}{hit.audience === 'internal' && <> <Badge>{t("operations.knowledge.internal")}</Badge></>}{hit.sourceUrl && <> <a className="small" href={hit.sourceUrl} target="_blank" rel="noreferrer">{t("operations.common.source")}</a></>}
        {hit.passages.map(passage => <div key={passage.section + passage.text.slice(0, 20)}>
          <p className="inline-meta"><span>{passage.section}</span>{result.mode !== 'external' && <><span>RRF {formatNumber(passage.score, locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span><span>{t("operations.knowledge.lexicalRank")} {passage.lexicalRank === null ? '—' : formatNumber(passage.lexicalRank, locale)}</span><span>{t("operations.knowledge.vectorRank")} {passage.vectorRank === null ? '—' : formatNumber(passage.vectorRank, locale)}{passage.similarity !== null ? ` (${formatNumber(passage.similarity, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ''}</span></>}</p>
          <p className="skill-content small">{passage.text}</p>
        </div>)}
      </li>)}</ol>
    </div>}
  </section>
}
