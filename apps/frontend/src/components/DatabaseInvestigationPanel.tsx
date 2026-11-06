import { Fragment, useState } from 'react'
import { useI18n } from '../i18n'
import { ApiError, UiError, request } from '../lib/api'
import { databaseLimitKeys, validDatabaseInvestigationPolicy, validDatabaseLimits, type DatabaseInvestigationPolicy } from '../lib/database-investigation'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { useDirtyForm } from '../lib/useDirtyForm'
import { useResource } from '../lib/useResource'
import { ErrorNotice } from './ErrorNotice'
import { Badge, Icon, Notice } from './ui'

export function DatabaseInvestigationPanel({ token, businessId }: { token: string; businessId: string }) {
  const { t } = useI18n()
  const path = `/guards/database?businessId=${encodeURIComponent(businessId)}`
  const resource = useResource<unknown>(path, token)
  const config = validDatabaseInvestigationPolicy(resource.data) ? resource.data : null
  return <section className="card padded" aria-labelledby="database-investigation-title">
    <h2 id="database-investigation-title"><Icon name="lock" size={18} />{t('bank.database.title')}</h2>
    <div className="inline-meta"><Badge>{t('bank.database.readOnly')}</Badge><Badge>{t('bank.database.scope')}</Badge></div>
    <p className="small muted">{t('bank.database.description')}</p>
    {resource.error && <ErrorNotice error={resource.errorCause}><button type="button" onClick={resource.refresh}>{t('core.common.retryRead')}</button></ErrorNotice>}
    {resource.checkedAt !== null && !config && <ErrorNotice error={new UiError('core.error.invalidResponse')} />}
    {resource.loading && resource.checkedAt === null && <p className="muted">{t('bank.database.loading')}</p>}
    {config && <DatabasePolicyEditor config={config} path={path} token={token} stale={!!resource.error} />}
  </section>
}

function DatabasePolicyEditor({ config, path, token, stale }: { config: DatabaseInvestigationPolicy; path: string; token: string; stale: boolean }) {
  const { t } = useI18n()
  const [snapshot, setSnapshot] = useState(config)
  const [draft, setDraft] = useState(() => ({ enabled: config.enabled, limits: { ...config.limits } }))
  const [latest, setLatest] = useState<DatabaseInvestigationPolicy | null>(null)
  const [conflict, setConflict] = useState(false), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const dirty = draft.enabled !== snapshot.enabled || databaseLimitKeys.some(key => draft.limits[key] !== snapshot.limits[key])
  useDirtyForm(dirty)
  const locked = stale || busy || !snapshot.sources.length || isReadOnlyDemo()
  async function readLatest() {
    setBusy(true); setError(null)
    try {
      const result = await request<unknown>(path, token)
      if (!validDatabaseInvestigationPolicy(result)) throw new UiError('core.error.invalidResponse')
      setLatest(result)
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  async function save() {
    if (locked || conflict || !dirty || !validDatabaseLimits(draft.limits)) return
    setBusy(true); setError(null); setSaved(false)
    try {
      const result = await request<unknown>(path, token, { method: 'PUT', body: { version: snapshot.version, enabled: draft.enabled, limits: draft.limits } })
      if (!validDatabaseInvestigationPolicy(result) || result.version <= snapshot.version) throw new UiError('core.error.invalidResponse')
      setSnapshot(result); setDraft({ enabled: result.enabled, limits: { ...result.limits } }); setLatest(null); setSaved(true)
    } catch (cause) { setError(cause); if (cause instanceof ApiError && cause.status === 409) setConflict(true) }
    finally { setBusy(false) }
  }
  return <form onSubmit={event => { event.preventDefault(); void save() }}>
    <p className="small muted">{t(snapshot.sources.length ? 'bank.database.configured' : 'bank.database.noSources')}</p>
    {snapshot.sources.length > 0 && <details><summary>{t('bank.database.sources')}</summary><ul>{snapshot.sources.map(source => <li key={source.id}>{source.label} · <code>{source.id}</code></li>)}</ul></details>}
    <fieldset className="database-investigation-fields" disabled={locked}>
      <legend className="sr-only">{t('bank.database.title')}</legend>
      <label className="check-option"><input type="checkbox" checked={draft.enabled} onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); setSaved(false) }} />{t('bank.database.enabled')}</label>
      <div className="two-columns">{databaseLimitKeys.map(key => <label key={key}>{t(`bank.database.${key}`)}<input type="number" required min={snapshot.bounds[key].min} max={snapshot.bounds[key].max} step={1} value={Number.isNaN(draft.limits[key]) ? '' : draft.limits[key]} onChange={event => { setDraft({ ...draft, limits: { ...draft.limits, [key]: event.target.valueAsNumber } }); setSaved(false) }} /></label>)}</div>
      <p className="field-hint">{t('bank.database.rowsHint')}</p>
    </fieldset>
    {conflict && <Notice>{t('bank.database.conflict')} <button type="button" disabled={busy} onClick={() => void readLatest()}>{t('requests.reviewLatest')}</button></Notice>}
    {latest && <section aria-label={t('bank.database.latest')}><h3>{t('bank.database.latest')} · v{latest.version}</h3><p>{t(latest.enabled ? 'bank.database.on' : 'bank.database.off')}</p><dl className="facts">{databaseLimitKeys.map(key => <Fragment key={key}><dt>{t(`bank.database.${key}`)}</dt><dd>{latest.limits[key]}</dd></Fragment>)}</dl><button type="button" disabled={busy || isReadOnlyDemo() || latest.version <= snapshot.version} onClick={() => { setSnapshot(latest); setLatest(null); setConflict(false); setError(null) }}>{t('bank.database.keepDraft')}</button></section>}
    {error !== null && <ErrorNotice error={error} />}{saved && <Notice>{t('bank.database.saved')}</Notice>}
    <div className="form-actions"><span className="small muted">v{snapshot.version}</span><button type="button" disabled={busy || !dirty} onClick={() => { setDraft({ enabled: snapshot.enabled, limits: { ...snapshot.limits } }); setSaved(false) }}>{t('bank.skills.discard')}</button><button className="primary" disabled={locked || conflict || !dirty || !validDatabaseLimits(draft.limits)}>{busy ? t('operations.common.saving') : t('bank.database.save')}</button></div>
  </form>
}
