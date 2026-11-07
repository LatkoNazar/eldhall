import { useState } from 'react'
import { useI18n, formatDateTime } from '../i18n'
import { ApiError, UiError, request } from '../lib/api'
import { validSkill, type Skill } from '../lib/banking'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { useDirtyForm } from '../lib/useDirtyForm'
import { useResource } from '../lib/useResource'
import { ErrorNotice } from './ErrorNotice'
import { Badge, Icon, Notice } from './ui'

export function SkillsPanel({ token, businessId }: { token: string; businessId: string }) {
  const { t } = useI18n()
  const path = `/skills?businessId=${encodeURIComponent(businessId)}`
  const resource = useResource<{ skills: Skill[]; preset: string }>(path, token)
  const [creating, setCreating] = useState(false)
  const data = resource.data
  const valid = !data || (data.skills.every(skill => validSkill(skill, businessId)) && new Set(data.skills.map(skill => skill.id)).size === data.skills.length)
  const stale = !!resource.error || !valid
  return <section className="card padded skills-section"><div className="page-heading"><div><h2>{t('operations.skills.title')}</h2><p>{t('bank.skills.description')}</p></div><button type="button" disabled={isReadOnlyDemo() || stale || creating} onClick={() => setCreating(true)}><Icon name="plus" size={17} />{t('operations.skills.add')}</button></div>
    <details><summary>{t('bank.skills.activation')}</summary><p className="small">{t('bank.skills.activationHelp')}</p><pre>{`---\nactivation: on_demand\ndescription: ${t('bank.skills.activationExample')}\n---\n`}</pre></details>
    {resource.error && <ErrorNotice error={resource.errorCause}><button type="button" onClick={resource.refresh}>{t('core.common.retryRead')}</button></ErrorNotice>}{!valid && <ErrorNotice error={new UiError('core.error.invalidResponse')} />}
    {valid && data && <><Badge>{t('operations.skills.preset')} {data.preset}</Badge>{data.skills.length ? data.skills.map(skill => <SkillEditor key={skill.id} skill={skill} businessId={businessId} token={token} stale={stale} onChanged={resource.refresh} />) : <p className="muted small">{t('operations.skills.empty')}</p>}</>}
    {creating && <CreateSkill path={path} businessId={businessId} token={token} stale={stale} onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); resource.refresh() }} />}
  </section>
}

function SkillEditor({ skill, businessId, token, stale, onChanged }: { skill: Skill; businessId: string; token: string; stale: boolean; onChanged: () => void }) {
  const { t, locale } = useI18n()
  const [content, setContent] = useState(skill.content)
  const [enabled, setEnabled] = useState(skill.enabled)
  const [revision, setRevision] = useState(skill.revision)
  const [baseline, setBaseline] = useState({ content: skill.content, enabled: skill.enabled })
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const dirty = content !== baseline.content || enabled !== baseline.enabled
  useDirtyForm(dirty)
  const changed = conflict || skill.revision > revision
  const locked = isReadOnlyDemo() || stale || busy
  async function save() {
    if (locked || !dirty || changed || !content.trim()) return
    setBusy(true); setError(null); setSaved(false)
    try {
      const result = await request<Skill>(`/skills/${encodeURIComponent(skill.id)}?businessId=${encodeURIComponent(businessId)}`, token, { method: 'PATCH', body: { revision, content: content.trim(), enabled } })
      if (!validSkill(result, businessId) || result.id !== skill.id || result.name !== skill.name) throw new UiError('core.error.invalidResponse')
      setRevision(result.revision); setContent(result.content); setEnabled(result.enabled); setBaseline({ content: result.content, enabled: result.enabled }); setSaved(true); onChanged()
    } catch (cause) { setError(cause); if (cause instanceof ApiError && cause.status === 409) { setConflict(true); onChanged() } }
    finally { setBusy(false) }
  }
  return <details className="skill-item"><summary>{skill.name} · v{revision} · {enabled ? t('operations.skills.enabled') : t('operations.skills.disabled')}</summary><form onSubmit={event => { event.preventDefault(); void save() }}>
    <label htmlFor={`skill-content-${skill.id}`}>{t('operations.skills.instructions')}</label><textarea id={`skill-content-${skill.id}`} required maxLength={30000} rows={6} disabled={locked} value={content} onChange={event => { setContent(event.target.value); setSaved(false) }} />
    <label className="check-option"><input type="checkbox" disabled={locked} checked={enabled} onChange={event => { setEnabled(event.target.checked); setSaved(false) }} />{t('bank.skills.enabled')}</label><small className="muted">{t('operations.common.updated')} {formatDateTime(skill.updatedAt, locale)}</small>
    {changed && <><Notice>{t('bank.skills.conflict')} <button type="button" disabled={locked || skill.revision === revision} onClick={() => { setRevision(skill.revision); setBaseline({ content: skill.content, enabled: skill.enabled }); setConflict(false); setError(null) }}>{t('requests.reviewLatest')}</button></Notice><label htmlFor={`skill-latest-${skill.id}`}>{t('bank.skills.latest')} · v{skill.revision} · {skill.enabled ? t('operations.skills.enabled') : t('operations.skills.disabled')}</label><textarea id={`skill-latest-${skill.id}`} readOnly value={skill.content} rows={4} /></>}{error !== null && <ErrorNotice error={error} />}{saved && <Notice>{t('operations.skills.saved')}</Notice>}
    <div className="form-actions"><button type="button" disabled={locked || !dirty} onClick={() => { setContent(skill.content); setEnabled(skill.enabled); setRevision(skill.revision); setBaseline({ content: skill.content, enabled: skill.enabled }); setConflict(false); setError(null) }}>{t('bank.skills.discard')}</button><button className="primary" disabled={locked || !dirty || changed || !content.trim()}>{busy ? t('operations.common.saving') : t('bank.skills.save')}</button></div>
  </form></details>
}

function CreateSkill({ path, businessId, token, stale, onCreated, onCancel }: { path: string; businessId: string; token: string; stale: boolean; onCreated: () => void; onCancel: () => void }) {
  const { t } = useI18n()
  const [name, setName] = useState(''), [content, setContent] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null)
  useDirtyForm(!!name || !!content)
  return <form className="skill-create" onSubmit={event => {
    event.preventDefault(); if (busy || stale || isReadOnlyDemo()) return
    setBusy(true); setError(null)
    void request<Skill>(path, token, { method: 'POST', body: { name: `custom/${name.trim()}`, content: content.trim(), enabled: true } }).then(result => { if (!validSkill(result, businessId)) throw new UiError('core.error.invalidResponse'); onCreated() }).catch(setError).finally(() => setBusy(false))
  }}><label htmlFor="skill-name">{t('operations.skills.name')}</label><input id="skill-name" required pattern="[a-z0-9][a-z0-9-]{0,63}" value={name} disabled={busy || stale} onChange={event => setName(event.target.value)} /><label htmlFor="skill-content">{t('operations.skills.instructions')}</label><textarea id="skill-content" required maxLength={30000} rows={5} value={content} disabled={busy || stale} onChange={event => setContent(event.target.value)} /><p className="field-hint">{t('operations.skills.nameHint')}</p>{error !== null && <ErrorNotice error={error} />}<div className="form-actions"><button type="button" disabled={busy} onClick={() => { if ((!name && !content) || window.confirm(t('operations.common.discardPrompt'))) onCancel() }}>{t('operations.common.cancel')}</button><button className="primary" disabled={busy || stale || isReadOnlyDemo()}>{busy ? t('operations.common.saving') : t('operations.skills.save')}</button></div></form>
}
