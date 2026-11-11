import { useState } from 'react'
import { useI18n, formatDateTime } from '../i18n'
import { ApiError, UiError, request } from '../lib/api'
import { validSkill, validSkillDraft, type Skill, type SkillDraft } from '../lib/banking'
import { isReadOnlyDemo } from '../lib/demo-mode'
import { useDirtyForm } from '../lib/useDirtyForm'
import { useResource } from '../lib/useResource'
import { ErrorNotice } from './ErrorNotice'
import { Badge, Icon, Notice } from './ui'

export function SkillsPanel({ token, businessId }: { token: string; businessId: string }) {
  const { t } = useI18n()
  const path = `/skills?businessId=${encodeURIComponent(businessId)}`
  const resource = useResource<{ skills: Skill[]; preset: string; canGenerate?: boolean }>(path, token)
  const [creating, setCreating] = useState(false)
  const data = resource.data
  const valid = !data || (data.skills.every(skill => validSkill(skill, businessId)) && new Set(data.skills.map(skill => skill.id)).size === data.skills.length)
  const stale = !!resource.error || !valid
  return <section className="card padded skills-section"><div className="page-heading"><div><h2>{t('operations.skills.title')}</h2><p>{t('bank.skills.description')}</p></div><button type="button" disabled={!data || isReadOnlyDemo() || stale || creating} onClick={() => setCreating(true)}><Icon name="plus" size={17} />{t('operations.skills.add')}</button></div>
    <details><summary>{t('bank.skills.activation')}</summary><p className="small">{t('bank.skills.activationHelp')}</p><pre>{`---\nactivation: on_demand\ndescription: ${t('bank.skills.activationExample')}\n---\n`}</pre></details>
    {resource.error && <ErrorNotice error={resource.errorCause}><button type="button" onClick={resource.refresh}>{t('core.common.retryRead')}</button></ErrorNotice>}{!valid && <ErrorNotice error={new UiError('core.error.invalidResponse')} />}
    {valid && data && <><Badge>{t('operations.skills.preset')} {data.preset}</Badge>{data.skills.length ? data.skills.map(skill => <SkillEditor key={skill.id} skill={skill} businessId={businessId} token={token} stale={stale} onChanged={resource.refresh} />) : <p className="muted small">{t('operations.skills.empty')}</p>}</>}
    {creating && <CreateSkill path={path} businessId={businessId} token={token} stale={stale} canGenerate={data?.canGenerate === true}
      skills={valid ? data?.skills ?? [] : []} onCancel={() => setCreating(false)} onCreated={() => { setCreating(false); resource.refresh() }} />}
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

function CreateSkill({ path, businessId, token, stale, canGenerate, skills, onCreated, onCancel }: {
  path: string; businessId: string; token: string; stale: boolean; canGenerate: boolean; skills: Skill[]
  onCreated: () => void; onCancel: () => void
}) {
  const { t } = useI18n()
  const [manual, setManual] = useState(false)
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [links, setLinks] = useState<string[]>([])
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const dirty = Boolean(description || name || content)
  useDirtyForm(dirty)
  const locked = busy || stale || isReadOnlyDemo()
  const showGenerator = canGenerate && !manual && !draft
  const duplicate = skills.some(skill => skill.name === `custom/${name.trim()}`)
  const close = () => { if (!dirty || window.confirm(t('operations.common.discardPrompt'))) onCancel() }

  async function generate() {
    if (locked || !canGenerate || description.trim().length < 10) return
    setBusy(true)
    setError(null)
    try {
      const result = await request<unknown>(`/skills/draft?businessId=${encodeURIComponent(businessId)}`, token, {
        method: 'POST', body: { description: description.trim() },
      })
      if (!validSkillDraft(result)) throw new UiError('core.error.invalidResponse')
      setDraft(result)
      setName(result.slug)
      setContent(result.content)
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 502 ? new UiError('bank.skills.draftError') : cause)
    } finally { setBusy(false) }
  }

  async function save() {
    if (locked || duplicate || !name.trim() || !content.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await request<Skill>(path, token, {
        method: 'POST', body: {
          name: `custom/${name.trim()}`, content: content.trim(), enabled: !draft,
          ...(links.length ? { relatedSkillIds: links } : {}),
        },
      })
      if (!validSkill(result, businessId) || result.enabled !== !draft) throw new UiError('core.error.invalidResponse')
      onCreated()
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }

  return <section className="skill-create">
    {showGenerator ? <form onSubmit={event => { event.preventDefault(); void generate() }}>
      <label htmlFor="skill-process">{t('bank.skills.process')}</label>
      <textarea id="skill-process" value={description} onChange={event => setDescription(event.target.value)} required minLength={10} maxLength={6000}
        rows={5} disabled={locked} placeholder={t('bank.skills.processExample')} />
      {error !== null && <ErrorNotice error={error} />}
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={close}>{t('operations.common.cancel')}</button>
        <button type="button" disabled={busy} onClick={() => { setManual(true); setError(null) }}>{t('bank.skills.writeManually')}</button>
        <button className="primary" disabled={locked || description.trim().length < 10}>{t(busy ? 'bank.skills.generating' : 'bank.skills.generate')}</button>
      </div>
    </form> : <form aria-labelledby={draft ? 'skill-draft-heading' : undefined} onSubmit={event => { event.preventDefault(); void save() }}>
      {draft && <div className="skill-draft-review">
        <h3 id="skill-draft-heading">{t('bank.skills.reviewDraft')}</h3>
        <p className="small muted">{t('bank.skills.savedDisabled')}</p>
        {draft.reviewedSkills < draft.totalSkills && <p className="small muted">{t('bank.skills.partialCatalog', { reviewed: draft.reviewedSkills, total: draft.totalSkills })}</p>}
        {draft.related.length > 0 && <fieldset className="skill-draft-links">
          <legend>{t('bank.skills.related')}</legend>
          {draft.related.map(ref => {
            const existing = skills.find(skill => skill.id === ref.id)
            const canLink = ref.kind === 'reuse' && ref.enabled && existing?.enabled !== false
            return <div className="skill-draft-link" key={ref.id}>
              <strong>{ref.name}</strong> <Badge>{t(ref.kind === 'reuse' ? 'bank.skills.reuse' : 'bank.skills.overlap')}</Badge>
              <p className="small">{ref.reason}</p>
              {existing && <details><summary>{t('bank.skills.readRelated')}</summary><pre className="skill-content">{existing.content}</pre></details>}
              {canLink && <label className="check-option">
                <input type="checkbox" disabled={locked} checked={links.includes(ref.id)} onChange={event => {
                  const checked = event.target.checked
                  setLinks(current => checked ? [...current, ref.id] : current.filter(id => id !== ref.id))
                }} />
                {t('bank.skills.addLink', { name: ref.name })}
              </label>}
            </div>
          })}
        </fieldset>}
      </div>}
      <label htmlFor="skill-name">{t('operations.skills.name')}</label>
      <input id="skill-name" required pattern={'[a-z0-9][a-z0-9\\-]{0,63}'} value={name} disabled={locked} onChange={event => setName(event.target.value)} />
      <label htmlFor="skill-content">{t('operations.skills.instructions')}</label>
      <textarea id="skill-content" required maxLength={30000} rows={draft ? 12 : 5} value={content} disabled={locked} onChange={event => setContent(event.target.value)} />
      {duplicate ? <Notice error>{t('bank.skills.duplicateName')}</Notice> : <p className="field-hint">{t('operations.skills.nameHint')}</p>}
      {error !== null && <ErrorNotice error={error} />}
      <div className="form-actions">
        <button type="button" disabled={busy} onClick={close}>{t('operations.common.cancel')}</button>
        {canGenerate && !draft && <button type="button" disabled={busy} onClick={() => { setManual(false); setError(null) }}>{t('bank.skills.fromDescription')}</button>}
        <button className="primary" disabled={locked || duplicate}>{t(busy ? 'operations.common.saving' : draft ? 'bank.skills.saveDraft' : 'operations.skills.save')}</button>
      </div>
    </form>}
  </section>
}
