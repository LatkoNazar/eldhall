import { useEffect, useRef, useState } from 'react'
import { useI18n, formatDateTime } from '../../i18n'
import { ApiError } from '../../lib/api'
import { confirmImport, importErrorCode, loadImportCapabilities, prepareImport, type ConfirmImport, type ImportCapabilities, type ImportPreview, type ImportResult } from '../../lib/integration-imports-api'
import { importConfirmation, initialReview, reviewedDefinition, type ImportOperationDraft, type ReviewDraft } from '../../lib/integration-review'
import { useDirtyForm } from '../../lib/useDirtyForm'
import { Badge, Empty, Icon, Notice } from '../ui'
import { OperationReviewFields } from './OperationReviewFields'
import { OperationRow } from './OperationRow'
import { PermissionModeControl } from './PermissionModeControl'
import { ImportErrorNotice } from './ImportErrorNotice'

function defaultId(value: string) {
  try { return ('api-' + new URL(value).hostname.replace(/[^A-Za-z0-9_.-]/g, '-')).slice(0, 64) } catch { return '' }
}
function defaultBase(value: string) { try { return new URL(value).origin } catch { return '' } }

export function IntegrationImportWizard({ businessId, token, onCancel, onConnected }: {
  businessId: string; token: string; onCancel: () => void; onConnected: (result: ImportResult) => void
}) {
  const { t, locale } = useI18n()
  const [capabilities, setCapabilities] = useState<ImportCapabilities | null>(null)
  const [capabilityRevision, setCapabilityRevision] = useState(0)
  const [capabilityError, setCapabilityError] = useState<unknown>(null)
  const [specUrl, setSpecUrl] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [integrationId, setIntegrationId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [profileId, setProfileId] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ImportOperationDraft>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<'prepare' | 'confirm' | ''>('')
  const [error, setError] = useState<unknown>(null)
  const [stale, setStale] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [retryPayload, setRetryPayload] = useState<ConfirmImport | null>(null)
  const [now, setNow] = useState(Date.now)
  const pending = useRef<AbortController | null>(null)
  const panel = useRef<HTMLElement>(null)
  const dirty = !!(specUrl || preview) && !result
  useDirtyForm(dirty)
  useEffect(() => {
    const controller = new AbortController()
    void loadImportCapabilities(businessId, token, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setCapabilities(value); setCapabilityError(null)
      setProfileId(current => current || value.credentialProfiles.find(profile => profile.configured && profile.id === 'none')?.id || value.credentialProfiles.find(profile => profile.configured)?.id || '')
    }).catch(cause => { if (!controller.signal.aborted) setCapabilityError(cause) })
    return () => controller.abort()
  }, [businessId, token, capabilityRevision])
  useEffect(() => () => pending.current?.abort(), [])
  useEffect(() => {
    if (!preview || result) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [preview, result])
  const profile = capabilities?.credentialProfiles.find(item => item.id === profileId)
  const submitted = !!retryPayload
  const expired = !!preview && !result && now >= Date.parse(preview.expiresAt)
  const confirmation = preview ? importConfirmation(preview, drafts) : null
  const missing = preview?.operations.find(operation => operation.supported && !reviewedDefinition(drafts[operation.operationKey]?.review ?? initialReview(operation)))
  const cancel = () => { if (!dirty || window.confirm(t('operations.common.discardPrompt'))) { pending.current?.abort(); onCancel() } }

  async function prepare() {
    if (!capabilities?.enabled || busy || !profile?.configured) return
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    setBusy('prepare'); setError(null); setStale(false)
    try {
      const value = await prepareImport({ integrationId, specUrl, credentialProfileId: profileId, ...(baseUrl.trim() ? { upstreamBaseUrl: baseUrl.trim() } : {}) }, businessId, token, controller.signal)
      if (controller.signal.aborted) return
      setPreview(value); setDrafts(Object.fromEntries(value.operations.map(operation => [operation.operationKey, { mode: 'deny', review: initialReview(operation) }])))
      setExpanded(null); setAcknowledged(false); setResult(null); setRetryPayload(null); setNow(Date.now())
    } catch (cause) { if (!controller.signal.aborted) setError(cause) }
    finally { if (!controller.signal.aborted) setBusy('') }
  }
  function update(operationKey: string, review: ReviewDraft) {
    setDrafts(current => ({ ...current, [operationKey]: { ...current[operationKey]!, review } })); setAcknowledged(false)
  }
  function changeSource() {
    if (dirty && !window.confirm(t('operations.common.discardPrompt'))) return
    pending.current?.abort(); setPreview(null); setResult(null); setRetryPayload(null); setError(null); setStale(false); setBusy(''); setAcknowledged(false)
  }
  async function connect(body: ConfirmImport) {
    if (!preview || busy || (!result && (!acknowledged || expired || stale))) return
    const controller = new AbortController(); pending.current?.abort(); pending.current = controller
    const exact = structuredClone(body)
    setRetryPayload(exact); setBusy('confirm'); setError(null)
    try {
      const saved = await confirmImport(preview.id, exact, businessId, preview.integrationId, token, controller.signal)
      if (!controller.signal.aborted) setResult(saved)
    } catch (cause) { if (!controller.signal.aborted) { setError(cause); if ((cause instanceof ApiError && cause.status === 409) || ['import_not_found', 'prepared_identity_mismatch'].includes(importErrorCode(cause) ?? '')) setStale(true); if (cause instanceof ApiError && cause.status === 422) setRetryPayload(null) } }
    finally { if (!controller.signal.aborted) setBusy('') }
  }
  function reviewNext() {
    if (!missing) return
    setExpanded(missing.operationKey)
    window.requestAnimationFrame(() => {
      const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-operation-key]') ?? [])].find(item => item.dataset.operationKey === missing.operationKey)
      row?.scrollIntoView?.({ block: 'nearest' }); row?.querySelector<HTMLSelectElement>('.operation-effect select')?.focus({ preventScroll: true })
    })
  }
  return <section className="integration-import" ref={panel} aria-label={t('onboarding.title')}>
    <header className="integration-import-heading"><button type="button" onClick={cancel}><Icon name="arrow" size={16} /><span>{t('operations.common.cancel')}</span></button><h2>{preview ? t('onboarding.previewTitle') : t('onboarding.title')}</h2></header>
    {Boolean(capabilityError) && <ImportErrorNotice error={capabilityError}><button onClick={() => setCapabilityRevision(value => value + 1)}>{t('core.common.retryRead')}</button></ImportErrorNotice>}
    {!capabilities ? !capabilityError && <Empty title={t('operations.integrations.loading')} /> : !capabilities.enabled ? <Notice>{t('onboarding.unavailable')}</Notice> : <>
      {Boolean(error) && <ImportErrorNotice error={error}>{stale && !importErrorCode(error) && <p>{t('onboarding.previewChanged')}</p>}</ImportErrorNotice>}
      {!preview ? <form className="integration-source-form integration-import-scroll" onSubmit={event => { event.preventDefault(); void prepare() }}>
        <p>{t('onboarding.description')}</p>
        <label>{t('onboarding.openapi')}<input type="url" value={specUrl} required maxLength={1000} autoComplete="off" disabled={!!busy} onChange={event => { setSpecUrl(event.target.value); if (!idEdited) setIntegrationId(defaultId(event.target.value)) }} /></label>
        <p className="field-hint">{t('onboarding.openapiHint')}</p>
        <label>{t('onboarding.profile')}<select disabled={!!busy} value={profileId} onChange={event => setProfileId(event.target.value)}>{capabilities.credentialProfiles.map(item => <option key={item.id} value={item.id} disabled={!item.configured}>{item.name}{!item.configured ? ` · ${t('onboarding.notConfigured')}` : ''}</option>)}</select></label>
        <p className="field-hint">{t('onboarding.profileHint')}</p>
        {!profile?.configured && <Notice>{t('onboarding.noProfiles')}</Notice>}
        <details><summary>{t('onboarding.advancedSource')}</summary>
          <label>{t('onboarding.id')}<input value={integrationId} maxLength={64} pattern="[A-Za-z0-9_.-]+" disabled={!!busy} onChange={event => { setIntegrationId(event.target.value); setIdEdited(true) }} /></label><p className="field-hint">{t('onboarding.idHint')}</p>
          <label>{t('onboarding.baseUrl')}<input type="url" value={baseUrl} maxLength={1000} disabled={!!busy} onChange={event => setBaseUrl(event.target.value)} /></label><p className="field-hint">{t('onboarding.baseHint')}</p>
        </details>
        {(baseUrl || profile?.upstreamBaseUrl || defaultBase(specUrl)) && <p className="integration-target"><strong>{t('onboarding.source')}</strong><code>{baseUrl || profile?.upstreamBaseUrl || defaultBase(specUrl)}</code></p>}
        <button type="submit" className="primary" disabled={!!busy || !profile?.configured || !integrationId || !specUrl}>{busy === 'prepare' ? t('onboarding.preparing') : t('onboarding.preview')}</button>
      </form> : <>
        <div className="integration-import-source"><p><strong>{t('onboarding.source')}</strong> <code>{preview.source.upstreamBaseUrl}</code></p><p className="small muted">{t('onboarding.openapi')}: <code>{preview.source.specUrl}</code></p><p className="small">{t('onboarding.profile')}: {capabilities.credentialProfiles.find(item => item.id === preview.credential.profileId)?.name ?? preview.credential.profileId} · {t('onboarding.expires')}: {formatDateTime(preview.expiresAt, locale)}</p>{!result && <button type="button" disabled={!!busy} onClick={changeSource}>{t('onboarding.changeSource')}</button>}</div>
        {expired && <Notice error>{t('onboarding.expired')}</Notice>}
        {result && <Notice>{result.activation === 'active' ? t('onboarding.complete') : result.runtime === 'unavailable' ? t('onboarding.savedDisabled') : t('operations.integrations.disabled')}<p className="small">{t('onboarding.verificationHint')}</p></Notice>}
        <div className="integration-tool-list" tabIndex={0} aria-label={t('operations.integrations.operationCatalog')}>
          <p className="small muted">{t('onboarding.original')}</p>
          {preview.operations.map(operation => {
            const row = drafts[operation.operationKey]!
            const valid = !!reviewedDefinition(row.review)
            return <OperationRow key={operation.operationKey} operationKey={operation.operationKey} method={operation.method} path={operation.path} title={operation.title} expanded={expanded === operation.operationKey} onToggle={() => setExpanded(expanded === operation.operationKey ? null : operation.operationKey)}
              status={<Badge value={!operation.supported ? 'denied' : valid ? 'ok' : 'draft'}>{!operation.supported ? t('onboarding.unsupported') : valid ? t('onboarding.configured') : t('onboarding.reviewRequired')}</Badge>}
              controls={<div className="integration-row-controls">{operation.supported && <label className="operation-effect"><span className="sr-only">{t('onboarding.effect')} {operation.title}</span><select value={row.review.effect} disabled={!!busy || submitted || expired || stale} onChange={event => { update(operation.operationKey, { ...row.review, effect: event.target.value as ReviewDraft['effect'] }); setExpanded(operation.operationKey) }}><option value="unknown">{t('onboarding.chooseEffect')}</option><option value="read">{t('operations.integrations.readEffect')}</option><option value="write">{t('operations.integrations.writeEffect')}</option></select></label>}<PermissionModeControl value={row.mode} label={t('onboarding.modeFor', { operation: operation.title })} disabled={!operation.supported || !!busy || submitted || expired || stale} onChange={mode => { setDrafts(current => ({ ...current, [operation.operationKey]: { ...current[operation.operationKey]!, mode } })); setAcknowledged(false) }} /></div>}>
              {operation.description && <p>{operation.description}</p>}
              {operation.supported ? <OperationReviewFields operation={operation} value={row.review} disabled={!!busy || submitted || expired || stale} guards={capabilities.guardDefinitions} reads={preview.operations.filter(item => item.supported && drafts[item.operationKey]?.review.effect === 'read')} onChange={review => update(operation.operationKey, review)} /> : <Notice>{t('onboarding.unsupported')}{operation.reasonCode && <p className="small">{t('onboarding.reason')}: <code>{operation.reasonCode}</code></p>}</Notice>}
            </OperationRow>
          })}
          {!preview.operations.length && <Empty title={t('operations.integrations.noOperations')} />}
        </div>
        <footer className="integration-import-footer">
          {!result ? <><p className="field-hint">{t('onboarding.reviewPositive')}</p>{missing && <button type="button" onClick={reviewNext}>{t('onboarding.reviewNext')}</button>}
            {preview.operations.every(operation => drafts[operation.operationKey]?.mode === 'deny') && <p className="small">{t('onboarding.noAllowed')}</p>}
            <label className="check-option"><input type="checkbox" checked={acknowledged} disabled={!confirmation || expired || stale || !!busy || submitted} onChange={event => setAcknowledged(event.target.checked)} />{t('onboarding.confirmAll')}</label>
            <button className="primary" disabled={!confirmation || !acknowledged || expired || stale || !!busy} onClick={() => { if (retryPayload ?? confirmation) void connect((retryPayload ?? confirmation)!) }}>{busy === 'confirm' ? t('onboarding.connecting') : retryPayload ? t('onboarding.retryConnection') : t('onboarding.connect')}</button>
          </> : <>{result.runtime === 'unavailable' && retryPayload && <button disabled={!!busy} onClick={() => void connect(retryPayload)}>{busy === 'confirm' ? t('onboarding.connecting') : t('onboarding.retryConnection')}</button>}<button className="primary" disabled={!!busy} onClick={() => onConnected(result)}>{t('onboarding.openCatalog')}</button></>}
        </footer>
      </>}
    </>}
  </section>
}
