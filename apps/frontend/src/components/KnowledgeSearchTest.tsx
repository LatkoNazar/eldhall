import { useEffect, useState } from 'react'
import { Badge, Icon, Notice } from './ui'
import { errorText, request } from '../lib/api'

// Mirrors KnowledgeSearchResult in apps/api/src/modules/knowledge/retriever.ts.
export interface KnowledgePassage { section: string; text: string; score: number; lexicalRank: number | null; vectorRank: number | null; similarity: number | null }
export interface KnowledgeHit { id: string; title: string; version: number; category?: string; audience?: 'customer' | 'internal'; sourceUrl?: string | null; content: string; section: string; score: number; passages: KnowledgePassage[] }
export interface KnowledgeIndex { embedder: { id: string }; vectorStore: string; chunks: number | null; staleChunks: number | null; published: number; urlImport: boolean }
export interface KnowledgeSearchResult { query: string; mode: string; embedder: string; tookMs: number; hits: KnowledgeHit[] }

function isResult(value: unknown): value is KnowledgeSearchResult {
  return typeof value === 'object' && value !== null && Array.isArray((value as { hits?: unknown }).hits)
}

/** Lets an operator ask a customer question and see exactly which published passages the AI would receive. */
export function KnowledgeSearchTest({ token, businessId }: { token: string; businessId: string }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null)
  const [audience, setAudience] = useState<'customer' | 'any'>('customer')
  const [plan, setPlan] = useState('')
  const [index, setIndex] = useState<KnowledgeIndex | null>(null)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    request<KnowledgeIndex>(`/knowledge/index?businessId=${encodeURIComponent(businessId)}`, token, { signal: controller.signal })
      .then(value => setIndex(value && typeof value === 'object' && 'embedder' in value ? value : null))
      .catch(() => setIndex(null))
    return () => controller.abort()
  }, [token, businessId, revision])

  async function reindex() {
    setBusy(true)
    setError('')
    try {
      const done = await request<{ documents: number; chunks: number }>(`/knowledge/reindex?businessId=${encodeURIComponent(businessId)}`, token, { method: 'POST', body: {} })
      setNotice(`Переіндексовано: документів ${done.documents}, фрагментів ${done.chunks}.`)
      setRevision(value => value + 1)
    } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }

  async function run() {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setError('')
    try {
      const value = await request<unknown>(`/knowledge/search?businessId=${encodeURIComponent(businessId)}&q=${encodeURIComponent(q)}&k=5&audience=${audience}${plan.trim() ? `&plan=${encodeURIComponent(plan.trim())}` : ''}`, token)
      if (!isResult(value)) throw new Error('Неочікувана відповідь сервера')
      setResult(value)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section className="card padded" aria-labelledby="kb-search-test-title">
    <h2 id="kb-search-test-title">Перевірка пошуку</h2>
    <p className="muted">Те саме, що отримає AI-помічник: лише опубліковані джерела цього бізнесу, гібридний пошук (ключові слова + вектори).</p>
    {index && <p className="inline-meta"><span>Індекс: {index.vectorStore === 'pgvector' ? 'PostgreSQL + pgvector' : 'у пам’яті'}</span><span>{index.embedder.id}</span><span>фрагментів: {index.chunks ?? '—'}{index.staleChunks ? ` · застарілих: ${index.staleChunks}` : ''}</span><button type="button" disabled={busy} onClick={() => void reindex()}>Переіндексувати</button></p>}
    {notice && <Notice>{notice}</Notice>}
    <form className="resource-toolbar" style={{ padding: 0 }} onSubmit={event => { event.preventDefault(); void run() }}>
      <label className="search-field"><Icon name="search" /><input aria-label="Питання клієнта" placeholder="Наприклад: мені списали двічі" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="Від імені" value={audience} onChange={event => setAudience(event.target.value === 'any' ? 'any' : 'customer')}><option value="customer">Як клієнт</option><option value="any">Як команда (з внутрішніми)</option></select>
      <input aria-label="Тариф клієнта" placeholder="Тариф (необов’язково)" maxLength={80} value={plan} onChange={event => setPlan(event.target.value)} style={{ maxWidth: 200 }} />
      <button type="submit" className="primary" disabled={busy || !query.trim()}>{busy ? 'Шукаємо…' : 'Перевірити'}</button>
    </form>
    {error && <Notice error>{error}</Notice>}
    {result && <div aria-live="polite">
      <p className="inline-meta" style={{ marginTop: 12 }}>{result.hits.length ? `Знайдено джерел: ${result.hits.length}` : 'Нічого не знайдено — AI відповість без бази знань або передасть людині.'} · {result.mode} · {result.embedder} · {result.tookMs} мс</p>
      <ol>{result.hits.map(hit => <li key={hit.id} className="skill-item">
        <strong className="break-word">{hit.title}</strong> <Badge>v{hit.version}</Badge>{hit.audience === 'internal' && <> <Badge>Внутрішній</Badge></>}{hit.sourceUrl && <> <a className="small" href={hit.sourceUrl} target="_blank" rel="noreferrer">джерело</a></>}
        {hit.passages.map(passage => <div key={passage.section + passage.text.slice(0, 20)}>
          <p className="inline-meta"><span>{passage.section}</span><span>RRF {passage.score.toFixed(4)}</span><span>ключові слова: {passage.lexicalRank ?? '—'}</span><span>вектор: {passage.vectorRank ?? '—'}{passage.similarity !== null ? ` (${passage.similarity.toFixed(2)})` : ''}</span></p>
          <p className="skill-content small">{passage.text}</p>
        </div>)}
      </li>)}</ol>
    </div>}
  </section>
}
