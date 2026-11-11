import { useI18n, formatNumber, formatDateTime, type UiMessage, type Translate } from '../i18n'
import { ErrorNotice } from '../components/ErrorNotice'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Avatar, Badge, Empty, Icon, Metric, Notice } from '../components/ui'
import { request } from '../lib/api'
import { useResource } from '../lib/useResource'
import { registerNavigationGuard } from '../lib/navigation'
import { KnowledgeSearchTest } from '../components/KnowledgeSearchTest'
import { AccessFields, KnowledgeImport } from '../components/KnowledgeImport'
import { KnowledgeVersions } from '../components/KnowledgeVersions'
import { parsePlans } from '../lib/knowledge'
import { WorkspaceProvider } from '../components/WorkspaceProvider'
import './knowledge.css'

interface Business { id: string; name: string; currency: string; slug: string }
interface Source { id: string; businessId: string; title: string; category: string; content: string; version: number; status: 'draft' | 'published' | 'revoked'; updatedAt: string; audience?: 'customer' | 'internal'; plans?: string[]; sourceUrl?: string | null }
interface KnowledgeData { sources: Source[]; capabilities: { create: boolean; update: boolean; publish: boolean; revoke: boolean } }
interface Member { id: string; name: string; role: string; assignedCases: number }
const DirtyScope = createContext<{ current: boolean } | null>(null)

function Scope({ token, children }: { token: string; children: (business: Business) => ReactNode }) {
  const dirty = useRef(false)
  return <WorkspaceProvider token={token}>{business => <DirtyScope.Provider key={business.id} value={dirty}>{children(business)}</DirtyScope.Provider>}</WorkspaceProvider>
}

export function Knowledge({ token }: { token: string }) { return <Scope token={token}>{business => <KnowledgePanel token={token} business={business} />}</Scope> }

function KnowledgePanel({ token, business }: { token: string; business: Business }) {
  const { t, locale, translateMessage } = useI18n()
  const resource = useResource<KnowledgeData>(`/knowledge?businessId=${business.id}`, token)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('documentId') ?? '')
  const [view, setView] = useState<'documents' | 'search'>('documents')
  const [dialog, setDialog] = useState<'create' | 'import' | null>(null)
  const [notice, setNotice] = useState<UiMessage | null>(null)
  const sources = resource.data?.sources ?? []
  const visible = sources.filter(source => (!category || source.category === category) && `${source.title} ${source.content}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)))
  const active = sources.find(source => source.id === selected) ?? sources[0]
  const dirty = useContext(DirtyScope)
  const categories = [...new Set(sources.map(source => source.category))].sort((a, b) => a.localeCompare(b, locale))
  const canAdd = resource.data?.capabilities.create && !resource.error
  const saved = (message: UiMessage) => { setNotice(message); resource.refresh() }
  const closeDialog = () => setDialog(null)
  function added(message: UiMessage, sourceId: string) {
    closeDialog()
    if (!dirty?.current) {
      setSearch('')
      setCategory('')
      setSelected(sourceId)
    }
    saved(message)
  }

  return <div className="knowledge-workspace">
    <h1 className="sr-only">{t("operations.knowledge.title")}</h1>
    <div className="page-toolbar knowledge-toolbar">
      <div className="tabs knowledge-tabs" role="tablist" aria-label={t('operations.knowledge.title')}>
        {(['documents', 'search'] as const).map(tab => <button
          key={tab} id={`knowledge-tab-${tab}`} role="tab" type="button"
          className={view === tab ? 'active' : ''} aria-selected={view === tab}
          aria-controls={`knowledge-panel-${tab}`} tabIndex={view === tab ? 0 : -1}
          onClick={() => setView(tab)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'documents' : event.key === 'End' ? 'search' : tab === 'documents' ? 'search' : 'documents'
            setView(next)
            document.getElementById(`knowledge-tab-${next}`)?.focus()
          }}
        >{t(tab === 'documents' ? 'operations.knowledge.documents' : 'operations.knowledge.searchTest')}</button>)}
      </div>
      {view === 'documents' && <div className="knowledge-toolbar-actions">
        <button type="button" disabled={!canAdd} onClick={() => setDialog('import')}>{t('operations.knowledge.importAction')}</button>
        <button className="primary" type="button" disabled={!canAdd} onClick={() => setDialog('create')}><Icon name="plus" size={18} />{t('operations.knowledge.addDocument')}</button>
      </div>}
    </div>
    <div id="knowledge-panel-documents" className="knowledge-view" role="tabpanel" aria-labelledby="knowledge-tab-documents" hidden={view !== 'documents'}>
      {resource.error && <ErrorNotice error={resource.errorCause}><button onClick={resource.refresh}>{t('operations.common.refresh')}</button></ErrorNotice>}
      {notice && <Notice>{translateMessage(notice)}</Notice>}
      {sources.length ? <div className="knowledge-layout">
        <section className="card knowledge-list" aria-label={t('operations.knowledge.documents')}>
          <div className="knowledge-filters">
            <label className="search-field"><Icon name="search" size={18} /><input aria-label={t('operations.knowledge.searchLabel')} placeholder={t('operations.knowledge.searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} /></label>
            <select aria-label={t('operations.knowledge.documentCategory')} value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">{t('operations.knowledge.allCategories')}</option>
              {categories.map(value => <option key={value}>{value}</option>)}
            </select>
          </div>
          {visible.length ? <ul className="knowledge-document-list">{visible.map(source => <li key={source.id}>
            <button type="button" className="knowledge-document" aria-pressed={source.id === active?.id} onClick={() => {
              if (source.id !== active?.id && allowDiscard(dirty?.current ?? false, t)) setSelected(source.id)
            }}>
              <Icon name="file" size={18} />
              <span className="knowledge-document-name">
                <strong>{source.title}</strong>
                <span className="knowledge-document-meta"><small>{source.category}</small><Badge value={source.status} /></span>
              </span>
            </button>
          </li>)}</ul> : <Empty icon="book" title={t('operations.knowledge.noMatches')}>{t('operations.knowledge.adjustSearch')}</Empty>}
        </section>
        {active && resource.data && <SourceEditor key={`${active.id}-${active.version}`} source={active} capabilities={resource.data.capabilities} token={token} onSaved={saved} />}
      </div> : !resource.error && <section className="card"><Empty icon="book" title={t(resource.loading ? 'operations.knowledge.loadingDocuments' : 'operations.knowledge.emptyTitle')}>
        {resource.data && t('operations.knowledge.addAndReview')}
      </Empty></section>}
    </div>
    <div id="knowledge-panel-search" className="knowledge-view knowledge-search-view" role="tabpanel" aria-labelledby="knowledge-tab-search" hidden={view !== 'search'}>
      <KnowledgeSearchTest token={token} businessId={business.id} active={view === 'search'} />
    </div>
    {dialog === 'create' && <CreateSource token={token} businessId={business.id} onClose={closeDialog} onCreated={sourceId => added({ key: 'operations.knowledge.draftCreated' }, sourceId)} />}
    {dialog === 'import' && <KnowledgeImport token={token} businessId={business.id} onClose={closeDialog} onImported={added} />}
  </div>
}

function SourceEditor({ source, capabilities, token, onSaved }: { source: Source; capabilities: KnowledgeData['capabilities']; token: string; onSaved: (message: UiMessage) => void }) {
  const { t, locale } = useI18n()
  const [title, setTitle] = useState(source.title)
  const [category, setCategory] = useState(source.category)
  const [content, setContent] = useState(source.content)
  const [audience, setAudience] = useState<'customer' | 'internal'>(source.audience ?? 'customer')
  const [plans, setPlans] = useState((source.plans ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
  const dirty = title !== source.title || category !== source.category || content !== source.content || audience !== (source.audience ?? 'customer') || parsePlans(plans).join('|') !== (source.plans ?? []).join('|')
  useUnsaved(dirty)
  if (source.status === 'revoked') return <section className="card source-detail padded"><h2>{source.title}</h2><Badge value="revoked" /><Notice>{t("operations.knowledge.revokedNotice")}</Notice><small className="muted">v{source.version} · {formatDateTime(source.updatedAt, locale)}</small></section>
  async function save(action: 'save' | 'publish' | 'revoke') {
    setBusy(true); setError(null)
    try {
      if (action === 'save') await request(`/knowledge/${source.id}?businessId=${source.businessId}`, token, { method: 'PATCH', body: { version: source.version, title: title.trim(), category: category.trim(), content: content.trim(), audience, plans: parsePlans(plans) } })
      else await request(`/knowledge/${source.id}/${action}?businessId=${source.businessId}`, token, { method: 'POST', body: { version: source.version } })
      onSaved({ key: action === 'save' ? "operations.knowledge.savedNotice" : action === 'publish' ? "operations.knowledge.publishedNotice" : "operations.knowledge.revokedConfirmation" })
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  return <section className="card source-detail padded" aria-label={source.title}>
    <form className="knowledge-editor" onSubmit={event => { event.preventDefault(); void save('save') }}>
      <div className="knowledge-editor-head">
        <div className="knowledge-editor-identity">
          <label className="sr-only" htmlFor="source-title">{t('operations.common.title')}</label>
          <input id="source-title" className="knowledge-title-input" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} disabled={!capabilities.update || busy} />
          <div className="inline-meta">
            <Badge value={source.status} /><span>v{source.version}</span><span>{source.category}</span>
            {source.audience === 'internal' && <Badge>{t('operations.knowledge.teamOnly')}</Badge>}
            {source.plans?.length ? <span>{t('operations.knowledge.plansPrefix')} {source.plans.join(', ')}</span> : null}
            {source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">{t('operations.common.source')}</a>}
          </div>
        </div>
        <div className="knowledge-editor-actions">
          <button type="submit" disabled={!dirty || busy || !capabilities.update}>{t('operations.knowledge.saveDraft')}</button>
          {source.status === 'published'
            ? <button className="outline-danger" type="button" disabled={busy || dirty || !capabilities.revoke} onClick={() => void save('revoke')}>{t('operations.knowledge.revoke')}</button>
            : <button className="primary" type="button" disabled={busy || dirty || !capabilities.publish} onClick={() => void save('publish')}>{t('operations.knowledge.publish')}</button>}
        </div>
      </div>
      {error !== null && <ErrorNotice error={error} />}
      <label htmlFor="source-content">{t('operations.knowledge.content')}</label>
      <textarea id="source-content" className="source-content" required maxLength={30000} value={content} onChange={event => setContent(event.target.value)} disabled={!capabilities.update || busy} />
      <details className="knowledge-editor-settings">
        <summary>{t('operations.knowledge.editorSettings')}</summary>
        <label htmlFor="source-category">{t('operations.common.category')}</label>
        <input id="source-category" required maxLength={80} value={category} onChange={event => setCategory(event.target.value)}
          onInvalid={event => event.currentTarget.closest('details')?.setAttribute('open', '')} disabled={!capabilities.update || busy} />
        <AccessFields idPrefix="source" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} disabled={!capabilities.update || busy} />
      </details>
      <p className="knowledge-editor-updated muted">{t('operations.common.updated')} {formatDateTime(source.updatedAt, locale)} · {t('core.common.kyiv')}</p>
    </form>
    <KnowledgeVersions token={token} businessId={source.businessId} sourceId={source.id} current={source.version} />
  </section>
}

function CreateSource({ token, businessId, onClose, onCreated }: { token: string; businessId: string; onClose: () => void; onCreated: (sourceId: string) => void }) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer')
  const [plans, setPlans] = useState('')
  const [error, setError] = useState<unknown | null>(null)
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close() }, [])
  return <dialog ref={dialog} className="modal" onCancel={event => { if (busy) event.preventDefault(); else onClose() }} aria-labelledby="create-source-title"><div className="modal-header"><h2 id="create-source-title">{t("operations.knowledge.newDocument")}</h2><button className="icon-button" disabled={busy} aria-label={t("operations.common.close")} onClick={onClose}><Icon name="close" /></button></div><form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setError(null); void request<Source>(`/knowledge?businessId=${businessId}`, token, { method: 'POST', body: { title: String(fields.get('title')).trim(), category: String(fields.get('category')).trim(), content: String(fields.get('content')).trim(), audience, plans: parsePlans(plans) } }).then(source => onCreated(source.id)).catch(cause => setError(cause)).finally(() => setBusy(false)) }}><label htmlFor="new-source-title">{t("operations.knowledge.documentTitle")}</label><input id="new-source-title" name="title" required maxLength={160} /><label htmlFor="new-source-category">{t("operations.common.category")}</label><input id="new-source-category" name="category" required maxLength={80} placeholder={t("operations.knowledge.categoryExample")} /><AccessFields idPrefix="new-source" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} disabled={busy} /><label htmlFor="new-source-content">{t("operations.knowledge.content")}</label><textarea id="new-source-content" name="content" required maxLength={30000} rows={9} /><p className="field-hint">{t("operations.knowledge.createHint")}</p>{Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}<div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>{t("operations.common.cancel")}</button><button type="submit" className="primary" disabled={busy}>{busy ? t("operations.knowledge.creating") : t("operations.knowledge.createDraft")}</button></div></form></dialog>
}

export function Team({ token }: { token: string }) {
  const { t, locale } = useI18n()
  const resource = useResource<{ members: Member[]; capabilities: { invite: boolean; updateRole: boolean } }>('/team', token, 10000)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const members = resource.data?.members ?? []
  const visible = members.filter(member => member.name.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)))
  const active = members.find(member => member.id === selected) ?? members[0]
  return <>
    <h1 className="sr-only">{t("operations.team.title")}</h1>
    {Boolean(resource.error) && <ErrorNotice error={resource.errorCause}> <button onClick={resource.refresh}>{t("operations.common.refresh")}</button></ErrorNotice>}
    <div className="metrics-grid team-metrics"><Metric icon="team" label={t("operations.team.operatorCount")} value={resource.data ? formatNumber(members.length, locale) : '—'} /><Metric icon="inbox" label={t("operations.team.assignedCases")} value={resource.data ? formatNumber(members.reduce((sum, member) => sum + member.assignedCases, 0), locale) : '—'} /></div>
    <div className="two-columns team-layout"><section className="card"><div className="resource-toolbar"><h2>{t("operations.team.operators")}</h2><label className="search-field"><Icon name="search" /><input aria-label={t("operations.team.searchLabel")} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("operations.team.searchPlaceholder")} /></label></div>{visible.length ? <div className="table-scroll"><table><thead><tr><th>{t("operations.team.name")}</th><th>{t("operations.team.role")}</th><th>{t("operations.team.cases")}</th></tr></thead><tbody>{visible.map(member => <tr key={member.id} className={member.id === active?.id ? 'selected-row' : ''}><td><button className="document-link" onClick={() => setSelected(member.id)}><Avatar name={member.name} seed={`operator:${member.id}`} /><strong>{member.name}</strong></button></td><td>{roleLabel(member.role, t)}</td><td>{formatNumber(member.assignedCases, locale)}</td></tr>)}</tbody></table></div> : <Empty icon="team" title={resource.loading ? t("operations.team.loading") : t("operations.team.noOperators")} />}</section><section className="card padded">{active ? <><div className="customer-heading"><Avatar name={active.name} seed={`operator:${active.id}`} /><div><h2>{active.name}</h2><Badge>{roleLabel(active.role, t)}</Badge></div></div><div className="section-divider" /><h3>{t("operations.team.assignedCases")}</h3><p className="large-number">{formatNumber(active.assignedCases, locale)}</p><Notice>{t("operations.team.unavailableFeatures")}</Notice></> : <Empty icon="team" title={t("operations.team.selectOperator")} />}</section></div>
  </>
}

function useUnsaved(dirty: boolean) {
  const { t } = useI18n()
  const scopeRef = useContext(DirtyScope)
  useEffect(() => {
    if (scopeRef) scopeRef.current = dirty
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    const removeGuard = registerNavigationGuard(() => allowDiscard(true, t))
    window.addEventListener('beforeunload', warn)
    return () => { removeGuard(); if (scopeRef) scopeRef.current = false; window.removeEventListener('beforeunload', warn) }
  }, [dirty, scopeRef, t])
}
function allowDiscard(dirty: boolean, t: Translate) { return !dirty || window.confirm(t("operations.common.discardPrompt")) }
function roleLabel(role: string, t: Translate) { return ({ staff: t("operations.team.operatorRole"), operator: t("operations.team.operatorRole"), admin: t("operations.team.adminRole"), 'support-agent': t("operations.team.supportRole") } as Record<string, string>)[role] ?? role }
