import { useState } from 'react'
import { Notice } from './ui'
import { errorText, request } from '../lib/api'
import { parsePlans } from '../lib/knowledge'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { const result = String(reader.result ?? ''); resolve(result.slice(result.indexOf(',') + 1)) }
    reader.onerror = () => reject(new Error('Не вдалося прочитати файл'))
    reader.readAsDataURL(file)
  })
}

/** Import from an allow-listed https page or a .md/.txt/.html file. Both create drafts; publishing stays a separate, explicit step. */
export function KnowledgeImport({ token, businessId, onImported }: { token: string; businessId: string; onImported: (message: string) => void }) {
  const [mode, setMode] = useState<'url' | 'file'>('url')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState('')
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer')
  const [plans, setPlans] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const common = { category: category.trim(), audience, plans: parsePlans(plans) }
      const created = mode === 'url'
        ? await request<{ title: string }>(`/knowledge/import-url?businessId=${encodeURIComponent(businessId)}`, token, { method: 'POST', body: { ...common, url: url.trim() } })
        : await request<{ title: string }>(`/knowledge/upload?businessId=${encodeURIComponent(businessId)}`, token, { method: 'POST', body: { ...common, filename: file!.name, contentBase64: await fileToBase64(file!) } })
      setUrl('')
      setFile(null)
      onImported(`Чернетку «${created.title}» створено. Перевірте текст і опублікуйте.`)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const ready = category.trim() && (mode === 'url' ? url.trim() : file)
  return <section className="card padded" aria-labelledby="kb-import-title">
    <h2 id="kb-import-title">Імпорт джерела</h2>
    <p className="muted">Сторінка довідки (лише дозволені домени, https) або файл .md, .txt, .html до 512 КБ. Імпорт створює чернетку — AI її не бачить до публікації.</p>
    <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: 0 }} role="group" aria-label="Джерело імпорту">
      <button type="button" className={mode === 'url' ? 'primary' : ''} aria-pressed={mode === 'url'} onClick={() => setMode('url')}>З сайту</button>
      <button type="button" className={mode === 'file' ? 'primary' : ''} aria-pressed={mode === 'file'} onClick={() => setMode('file')}>З файлу</button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (ready) void submit() }}>
      {mode === 'url'
        ? <><label htmlFor="kb-import-url">Адреса сторінки</label><input id="kb-import-url" type="url" inputMode="url" placeholder="https://help.example.com/refunds" maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} /></>
        : <><label htmlFor="kb-import-file">Файл</label><input id="kb-import-file" type="file" accept=".md,.markdown,.txt,.html,.htm" onChange={event => setFile(event.target.files?.[0] ?? null)} /></>}
      <label htmlFor="kb-import-category">Категорія</label>
      <input id="kb-import-category" required maxLength={80} placeholder="Наприклад, Оплата" value={category} onChange={event => setCategory(event.target.value)} />
      <AccessFields idPrefix="kb-import" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} />
      {error && <Notice error>{error}</Notice>}
      <div className="form-actions"><button type="submit" className="primary" disabled={busy || !ready}>{busy ? 'Імпортуємо…' : 'Імпортувати як чернетку'}</button></div>
    </form>
  </section>
}

/** Audience and plan scope of a source: shared by import, create and edit. */
export function AccessFields({ idPrefix, audience, plans, onAudience, onPlans, disabled = false }: { idPrefix: string; audience: 'customer' | 'internal'; plans: string; onAudience: (value: 'customer' | 'internal') => void; onPlans: (value: string) => void; disabled?: boolean }) {
  return <>
    <label htmlFor={`${idPrefix}-audience`}>Хто бачить</label>
    <select id={`${idPrefix}-audience`} value={audience} disabled={disabled} onChange={event => onAudience(event.target.value === 'internal' ? 'internal' : 'customer')}>
      <option value="customer">Клієнти та AI-помічник</option>
      <option value="internal">Лише команда (AI клієнтам не цитує)</option>
    </select>
    <label htmlFor={`${idPrefix}-plans`}>Тарифи</label>
    <input id={`${idPrefix}-plans`} maxLength={400} placeholder="Порожньо — для всіх; або через кому: Annual, Premium monthly" value={plans} disabled={disabled} onChange={event => onPlans(event.target.value)} />
  </>
}
