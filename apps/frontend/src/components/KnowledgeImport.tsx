import { useI18n, type UiMessage } from '../i18n'
import { ErrorNotice } from './ErrorNotice'
import { useRef, useState } from 'react'
import { request, UiError } from '../lib/api'
import { parsePlans } from '../lib/knowledge'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { const result = String(reader.result ?? ''); resolve(result.slice(result.indexOf(',') + 1)) }
    reader.onerror = () => reject(new UiError("operations.knowledge.fileReadError"))
    reader.readAsDataURL(file)
  })
}

/** Import from an allow-listed https page or a .md/.txt/.html file. Both create drafts; publishing stays a separate, explicit step. */
export function KnowledgeImport({ token, businessId, onImported }: { token: string; businessId: string; onImported: (message: UiMessage) => void }) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'url' | 'file'>('url')
  const [url, setUrl] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('')
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer')
  const [plans, setPlans] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const common = { category: category.trim(), audience, plans: parsePlans(plans) }
      const created = mode === 'url'
        ? await request<{ title: string }>(`/knowledge/import-url?businessId=${encodeURIComponent(businessId)}`, token, { method: 'POST', body: { ...common, url: url.trim() } })
        : await request<{ title: string }>(`/knowledge/upload?businessId=${encodeURIComponent(businessId)}`, token, { method: 'POST', body: { ...common, filename: file!.name, contentBase64: await fileToBase64(file!) } })
      setUrl('')
      setFile(null)
      if (fileInput.current) fileInput.current.value = ''
      onImported({ key: 'operations.knowledge.importCreated', values: { title: created.title } })
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  const ready = category.trim() && (mode === 'url' ? url.trim() : file)
  return <section className="card padded" aria-labelledby="kb-import-title">
    <h2 id="kb-import-title">{t("operations.knowledge.importTitle")}</h2>
    <p className="muted">{t("operations.knowledge.importDescription")}</p>
    <div className="form-actions" style={{ justifyContent: 'flex-start', marginTop: 0 }} role="group" aria-label={t("operations.knowledge.importSource")}>
      <button type="button" className={mode === 'url' ? 'primary' : ''} aria-pressed={mode === 'url'} onClick={() => setMode('url')}>{t("operations.knowledge.fromWebsite")}</button>
      <button type="button" className={mode === 'file' ? 'primary' : ''} aria-pressed={mode === 'file'} onClick={() => setMode('file')}>{t("operations.knowledge.fromFile")}</button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (ready && !busy) void submit() }}>
      {mode === 'url'
        ? <><label htmlFor="kb-import-url">{t("operations.knowledge.pageAddress")}</label><input key="url" id="kb-import-url" type="url" inputMode="url" placeholder="https://help.example.com/refunds" maxLength={2000} value={url} onChange={event => setUrl(event.target.value)} /></>
        : <><label htmlFor="kb-import-file">{t("operations.knowledge.file")}</label><input key="file" ref={fileInput} id="kb-import-file" type="file" accept=".md,.markdown,.txt,.html,.htm" onChange={event => setFile(event.target.files?.[0] ?? null)} /></>}
      <label htmlFor="kb-import-category">{t("operations.common.category")}</label>
      <input id="kb-import-category" required maxLength={80} placeholder={t("operations.knowledge.categoryExample")} value={category} onChange={event => setCategory(event.target.value)} />
      <AccessFields idPrefix="kb-import" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} />
      {Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}
      <div className="form-actions"><button type="submit" className="primary" disabled={busy || !ready}>{busy ? t("operations.knowledge.importing") : t("operations.knowledge.importDraft")}</button></div>
    </form>
  </section>
}

/** Audience and plan scope of a source: shared by import, create and edit. */
export function AccessFields({ idPrefix, audience, plans, onAudience, onPlans, disabled = false }: { idPrefix: string; audience: 'customer' | 'internal'; plans: string; onAudience: (value: 'customer' | 'internal') => void; onPlans: (value: string) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return <>
    <label htmlFor={`${idPrefix}-audience`}>{t("operations.knowledge.visibility")}</label>
    <select id={`${idPrefix}-audience`} value={audience} disabled={disabled} onChange={event => onAudience(event.target.value === 'internal' ? 'internal' : 'customer')}>
      <option value="customer">{t("operations.knowledge.customerAudience")}</option>
      <option value="internal">{t("operations.knowledge.internalAudience")}</option>
    </select>
    <label htmlFor={`${idPrefix}-plans`}>{t("operations.knowledge.plans")}</label>
    <input id={`${idPrefix}-plans`} maxLength={400} placeholder={t("operations.knowledge.plansPlaceholder")} value={plans} disabled={disabled} onChange={event => onPlans(event.target.value)} />
  </>
}
