import { useI18n, formatNumber, formatDateTime, formatPercent, type UiMessage, type Translate } from '../i18n'
import { ErrorNotice } from '../components/ErrorNotice'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Avatar, Badge, Empty, Icon, Metric, Notice } from '../components/ui'
import { request, toolLabel } from '../lib/api'
import type { ClassificationConfig } from '../lib/api'
import { useResource } from '../lib/useResource'
import { registerNavigationGuard } from '../lib/navigation'
import { KnowledgeSearchTest } from '../components/KnowledgeSearchTest'
import { AccessFields, KnowledgeImport } from '../components/KnowledgeImport'
import { KnowledgeVersions } from '../components/KnowledgeVersions'
import { parsePlans } from '../lib/knowledge'
import { WorkspaceProvider } from '../components/WorkspaceProvider'
import { SkillsPanel } from '../components/SkillsPanel'
import { GuardsPanel } from '../components/GuardsPanel'

interface Business { id: string; name: string; currency: string; slug: string }
interface Source { id: string; businessId: string; title: string; category: string; content: string; version: number; status: 'draft' | 'published' | 'revoked'; updatedAt: string; audience?: 'customer' | 'internal'; plans?: string[]; sourceUrl?: string | null }
interface KnowledgeData { sources: Source[]; capabilities: { create: boolean; update: boolean; publish: boolean; revoke: boolean } }
interface SettingsData { businessId: string; version: number; language: string; tone: string; requireApproval: boolean; refundLimitCents: number; duplicateWindowMinutes: number; enabledTools: string[]; classification?: ClassificationConfig | null }
interface Member { id: string; name: string; role: string; assignedCases: number }
const DirtyScope = createContext<{ current: boolean } | null>(null)

function Scope({ token, children }: { token: string; children: (business: Business) => ReactNode }) {
  const dirty = useRef(false)
  return <WorkspaceProvider token={token}>{business => <DirtyScope.Provider value={dirty}><div key={business.id}>{children(business)}</div></DirtyScope.Provider>}</WorkspaceProvider>
}

export function Knowledge({ token }: { token: string }) { return <Scope token={token}>{business => <KnowledgePanel token={token} business={business} />}</Scope> }

function KnowledgePanel({ token, business }: { token: string; business: Business }) {
  const { t, locale, translateMessage } = useI18n()
  const resource = useResource<KnowledgeData>(`/knowledge?businessId=${business.id}`, token)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('documentId') ?? '')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<UiMessage | null>(null)
  const sources = resource.data?.sources ?? []
  const visible = sources.filter(source => (!category || source.category === category) && `${source.title} ${source.content}`.toLocaleLowerCase(locale).includes(search.toLocaleLowerCase(locale)))
  const active = sources.find(source => source.id === selected) ?? sources[0]
  const dirty = useContext(DirtyScope)
  return <>
    <h1 className="sr-only">{t("operations.knowledge.title")}</h1>
    {Boolean(resource.error) && <ErrorNotice error={resource.errorCause}> <button onClick={resource.refresh}>{t("operations.common.refresh")}</button></ErrorNotice>}{notice && <Notice>{translateMessage(notice)}</Notice>}
    <div className="page-toolbar knowledge-toolbar"><label className="search-field"><Icon name="search" /><input aria-label={t("operations.knowledge.searchLabel")} placeholder={t("operations.knowledge.searchPlaceholder")} value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label={t("operations.knowledge.documentCategory")} value={category} onChange={event => setCategory(event.target.value)}><option value="">{t("operations.knowledge.allCategories")}</option>{Array.from(new Set(sources.map(source => source.category))).map(value => <option key={value}>{value}</option>)}</select><button className="primary" disabled={!resource.data?.capabilities.create} onClick={() => setCreating(true)}><Icon name="plus" />{t("operations.knowledge.addDocument")}</button></div>
    <div className="knowledge-layout">
      <section className="card knowledge-list">
        {visible.length ? <div className="table-scroll"><table><caption className="sr-only">{t("operations.knowledge.businessDocuments")} {business.name}</caption><thead><tr><th>{t("operations.common.document")}</th><th>{t("operations.common.version")}</th><th>{t("operations.common.status")}</th></tr></thead><tbody>{visible.map(source => <tr key={source.id} className={source.id === active?.id ? 'selected-row' : ''}><td><button className="document-link" onClick={() => { if (allowDiscard(dirty?.current ?? false, t)) setSelected(source.id) }} aria-pressed={source.id === active?.id}><Icon name="file" /><span><strong>{source.title}</strong><small>{source.category}</small></span></button></td><td>v{source.version}</td><td><Badge value={source.status} /></td></tr>)}</tbody></table></div> : <Empty icon="book" title={resource.loading ? t("operations.knowledge.loadingDocuments") : sources.length ? t("operations.knowledge.noMatches") : t("operations.knowledge.emptyTitle")}>{sources.length ? t("operations.knowledge.adjustSearch") : t("operations.knowledge.addAndReview")}</Empty>}
      </section>
      {active && resource.data ? <SourceEditor key={`${active.id}-${active.version}`} source={active} capabilities={resource.data.capabilities} token={token} onSaved={message => { setNotice(message); resource.refresh() }} /> : <section className="card"><Empty icon="file" title={t("operations.knowledge.selectDocument")}>{t("operations.knowledge.selectionHint")}</Empty></section>}
    </div>
    <Notice>{t("operations.knowledge.accessPolicy")}</Notice>
    <div className="two-columns"><KnowledgeSearchTest key={`search-${business.id}`} token={token} businessId={business.id} /><KnowledgeImport key={`import-${business.id}`} token={token} businessId={business.id} onImported={message => { setNotice(message); resource.refresh() }} /></div>
    {creating && <CreateSource token={token} businessId={business.id} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setNotice({ key: "operations.knowledge.draftCreated" }); resource.refresh() }} />}
  </>
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
  if (source.status === 'revoked') return <section className="card padded"><h2>{source.title}</h2><Badge value="revoked" /><Notice>{t("operations.knowledge.revokedNotice")}</Notice><small className="muted">v{source.version} · {formatDateTime(source.updatedAt, locale)}</small></section>
  async function save(action: 'save' | 'publish' | 'revoke') {
    setBusy(true); setError(null)
    try {
      if (action === 'save') await request(`/knowledge/${source.id}?businessId=${source.businessId}`, token, { method: 'PATCH', body: { version: source.version, title: title.trim(), category: category.trim(), content: content.trim(), audience, plans: parsePlans(plans) } })
      else await request(`/knowledge/${source.id}/${action}?businessId=${source.businessId}`, token, { method: 'POST', body: { version: source.version } })
      onSaved({ key: action === 'save' ? "operations.knowledge.savedNotice" : action === 'publish' ? "operations.knowledge.publishedNotice" : "operations.knowledge.revokedConfirmation" })
    } catch (cause) { setError(cause) }
    finally { setBusy(false) }
  }
  return <section className="card source-detail padded"><div className="source-heading"><span className="source-file-icon"><Icon name="file" size={28} /></span><div><h2>{source.title}</h2><div className="inline-meta"><span>{source.category}</span><span>v{source.version}</span><Badge value={source.status} />{source.audience === 'internal' && <Badge>{t("operations.knowledge.teamOnly")}</Badge>}{source.plans?.length ? <span>{t("operations.knowledge.plansPrefix")} {source.plans.join(', ')}</span> : null}{source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer">{t("operations.common.source")}</a>}</div></div></div>
    <form onSubmit={event => { event.preventDefault(); void save('save') }}><label htmlFor="source-title">{t("operations.common.title")}</label><input id="source-title" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} disabled={!capabilities.update || busy} /><label htmlFor="source-category">{t("operations.common.category")}</label><input id="source-category" required maxLength={80} value={category} onChange={event => setCategory(event.target.value)} disabled={!capabilities.update || busy} /><AccessFields idPrefix="source" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} disabled={!capabilities.update || busy} /><label htmlFor="source-content">{t("operations.knowledge.content")}</label><textarea id="source-content" className="source-content" required maxLength={30000} value={content} onChange={event => setContent(event.target.value)} disabled={!capabilities.update || busy} /><p className="field-hint">{t("operations.common.updated")} {formatDateTime(source.updatedAt, locale)} {t("operations.knowledge.savePublishSeparate")}</p>{Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}<div className="form-actions"><button type="submit" disabled={!dirty || busy || !capabilities.update}>{t("operations.knowledge.saveDraft")}</button>{source.status !== 'published' && <button className="primary" type="button" disabled={busy || dirty || !capabilities.publish} onClick={() => void save('publish')}><Icon name="check" size={17} />{t("operations.knowledge.publish")}</button>}{source.status === 'published' && <button className="outline-danger" type="button" disabled={busy || dirty || !capabilities.revoke} onClick={() => void save('revoke')}>{t("operations.knowledge.revoke")}</button>}</div>{dirty && <p className="field-hint">{t("operations.knowledge.saveFirst")}</p>}</form>
    <KnowledgeVersions token={token} businessId={source.businessId} sourceId={source.id} current={source.version} />
  </section>
}

function CreateSource({ token, businessId, onClose, onCreated }: { token: string; businessId: string; onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [audience, setAudience] = useState<'customer' | 'internal'>('customer')
  const [plans, setPlans] = useState('')
  const [error, setError] = useState<unknown | null>(null)
  useEffect(() => { dialog.current?.showModal(); const element = dialog.current; return () => element?.close() }, [])
  return <dialog ref={dialog} className="modal" onCancel={event => { if (busy) event.preventDefault(); else onClose() }} aria-labelledby="create-source-title"><div className="modal-header"><h2 id="create-source-title">{t("operations.knowledge.newDocument")}</h2><button className="icon-button" disabled={busy} aria-label={t("operations.common.close")} onClick={onClose}><Icon name="close" /></button></div><form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); setBusy(true); setError(null); void request(`/knowledge?businessId=${businessId}`, token, { method: 'POST', body: { title: String(fields.get('title')).trim(), category: String(fields.get('category')).trim(), content: String(fields.get('content')).trim(), audience, plans: parsePlans(plans) } }).then(onCreated).catch(cause => setError(cause)).finally(() => setBusy(false)) }}><label htmlFor="new-source-title">{t("operations.knowledge.documentTitle")}</label><input id="new-source-title" name="title" required maxLength={160} /><label htmlFor="new-source-category">{t("operations.common.category")}</label><input id="new-source-category" name="category" required maxLength={80} placeholder={t("operations.knowledge.categoryExample")} /><AccessFields idPrefix="new-source" audience={audience} plans={plans} onAudience={setAudience} onPlans={setPlans} disabled={busy} /><label htmlFor="new-source-content">{t("operations.knowledge.content")}</label><textarea id="new-source-content" name="content" required maxLength={30000} rows={9} /><p className="field-hint">{t("operations.knowledge.createHint")}</p>{Boolean(error) && <ErrorNotice error={error}></ErrorNotice>}<div className="form-actions"><button type="button" disabled={busy} onClick={onClose}>{t("operations.common.cancel")}</button><button type="submit" className="primary" disabled={busy}>{busy ? t("operations.knowledge.creating") : t("operations.knowledge.createDraft")}</button></div></form></dialog>
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
    <div className="metrics-grid team-metrics"><Metric icon="team" label={t("operations.team.operatorCount")} value={resource.data ? formatNumber(members.length, locale) : '—'} /><Metric icon="inbox" label={t("operations.team.assignedCases")} value={resource.data ? formatNumber(members.reduce((sum, member) => sum + member.assignedCases, 0), locale) : '—'} /><Metric icon="lock" label={t("operations.team.accessMode")} value={t("operations.team.staffAccess")} hint={t("operations.team.identityChecked")} /></div>
    <div className="two-columns team-layout"><section className="card"><div className="resource-toolbar"><h2>{t("operations.team.operators")}</h2><label className="search-field"><Icon name="search" /><input aria-label={t("operations.team.searchLabel")} value={search} onChange={event => setSearch(event.target.value)} placeholder={t("operations.team.searchPlaceholder")} /></label></div>{visible.length ? <div className="table-scroll"><table><thead><tr><th>{t("operations.team.name")}</th><th>{t("operations.team.role")}</th><th>{t("operations.team.cases")}</th></tr></thead><tbody>{visible.map(member => <tr key={member.id} className={member.id === active?.id ? 'selected-row' : ''}><td><button className="document-link" onClick={() => setSelected(member.id)}><Avatar name={member.name} seed={`operator:${member.id}`} /><strong>{member.name}</strong></button></td><td>{roleLabel(member.role, t)}</td><td>{formatNumber(member.assignedCases, locale)}</td></tr>)}</tbody></table></div> : <Empty icon="team" title={resource.loading ? t("operations.team.loading") : t("operations.team.noOperators")} />}</section><section className="card padded">{active ? <><div className="customer-heading"><Avatar name={active.name} seed={`operator:${active.id}`} /><div><h2>{active.name}</h2><Badge>{roleLabel(active.role, t)}</Badge></div></div><div className="section-divider" /><h3>{t("operations.team.workload")}</h3><p className="large-number">{formatNumber(active.assignedCases, locale)}</p><p className="muted">{t("operations.team.workloadHint")}</p><div className="section-divider" /><h3>{t("operations.team.access")}</h3><p>{t("operations.team.requestAuthorization")}</p><Notice>{t("operations.team.unavailableFeatures")}</Notice></> : <Empty icon="team" title={t("operations.team.selectOperator")} />}</section></div>
  </>
}

export function Settings({ token }: { token: string }) { return <Scope token={token}>{business => <SettingsPanel token={token} business={business} />}</Scope> }

function SettingsPanel({ token, business }: { token: string; business: Business }) {
  const { t, locale, translateMessage } = useI18n()
  const resource = useResource<SettingsData>(`/settings?businessId=${business.id}`, token)
  const [notice, setNotice] = useState<UiMessage | null>(null)
  return <><h1 className="sr-only">{t("operations.settings.title")}</h1>{notice && <Notice>{translateMessage(notice)}</Notice>}{Boolean(resource.error) && <ErrorNotice error={resource.errorCause}> <button onClick={resource.refresh}>{t("operations.common.refresh")}</button></ErrorNotice>}{resource.data ? <><SettingsEditor key={resource.data.version} settings={resource.data} business={business} token={token} onSaved={() => { setNotice({ key: "operations.settings.saved" }); resource.refresh() }} /><section className="card padded"><h2>{t("operations.settings.classification")}</h2>{resource.data.classification ? <><p className="muted">{t("operations.settings.businessRevision")} {resource.data.classification.revision}{t("operations.settings.classificationEditing")}</p><p>{t("operations.settings.confidenceThreshold")} {formatPercent(resource.data.classification.minimumConfidence, locale)}{t("operations.settings.thresholdHint")}</p><ul>{resource.data.classification.classes.map(item => <li key={item.id}><strong className="break-word">{item.label}</strong> <small className="muted">ID {item.id}{item.id === resource.data?.classification?.fallbackClassId ? t("operations.settings.fallbackClass") : ''}</small><p className="small">{item.description}</p></li>)}</ul></> : <p className="muted">{t("operations.settings.noClasses")}</p>}</section><GuardsPanel token={token} businessId={business.id} currency={business.currency} /><SkillsPanel token={token} businessId={business.id} /></> : <div className="card"><Empty icon="settings" title={resource.loading ? t("operations.settings.loading") : t("operations.settings.unavailable")} /></div>}</>
}

function SettingsEditor({ settings, business, token, onSaved }: { settings: SettingsData; business: Business; token: string; onSaved: () => void }) {
  const { t } = useI18n()
  const [language, setLanguage] = useState(settings.language)
  const [tone, setTone] = useState(settings.tone)
  const [limit, setLimit] = useState(String(settings.refundLimitCents / 100))
  const [windowMinutes, setWindowMinutes] = useState(String(settings.duplicateWindowMinutes))
  const [tools, setTools] = useState(settings.enabledTools)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown | null>(null)
  const dirty = language !== settings.language || tone !== settings.tone || Number(limit) * 100 !== settings.refundLimitCents || Number(windowMinutes) !== settings.duplicateWindowMinutes || JSON.stringify(tools) !== JSON.stringify(settings.enabledTools)
  useUnsaved(dirty)
  return <form onSubmit={event => { event.preventDefault(); if (!dirty || busy) return; setBusy(true); setError(null); void request(`/settings?businessId=${business.id}`, token, { method: 'PATCH', body: { version: settings.version, language, tone, requireApproval: true, refundLimitCents: Math.round(Number(limit) * 100), duplicateWindowMinutes: Number(windowMinutes), enabledTools: tools } }).then(onSaved).catch(cause => setError(cause)).finally(() => setBusy(false)) }}>
    <div className="two-columns settings-columns"><div className="settings-stack"><section className="card padded"><h2>{t("operations.settings.customerCommunication")}</h2><p className="muted">{t("operations.settings.responsePreferences")}</p><label htmlFor="language">{t("operations.settings.replyLanguage")}</label><select id="language" value={language} onChange={event => setLanguage(event.target.value)}><option value="uk">{t("operations.settings.ukrainian")}</option><option value="en">{t('operations.settings.english')}</option></select><label htmlFor="tone">{t("operations.settings.tone")}</label><select id="tone" value={tone} onChange={event => setTone(event.target.value)}><option value="neutral">{t("operations.settings.neutral")}</option><option value="empathetic">{t("operations.settings.empathetic")}</option><option value="de-escalating">{t("operations.settings.deescalating")}</option></select></section><section className="card padded"><h2>{t("operations.settings.allowedTools")}</h2><p className="muted">{t("operations.settings.toolsPolicyHint")}</p>{['lookup_payments', 'refund_payment', 'escalate_to_human'].map(tool => <label className="check-option" key={tool}><input type="checkbox" checked={tools.includes(tool)} onChange={event => setTools(previous => event.target.checked ? [...previous, tool] : previous.filter(item => item !== tool))} /><span>{toolLabel(tool, t)}<small>{tool === 'lookup_payments' ? t("operations.settings.readPayments") : tool === 'refund_payment' ? t("operations.settings.approvedFinancialAction") : t("operations.settings.humanHandoff")}</small></span></label>)}</section></div>
      <div className="settings-stack"><section className="card padded"><h2>{t("operations.settings.actionRules")}</h2><p className="muted">{t("operations.settings.recheckedBeforeExecution")}</p><label htmlFor="refund-limit">{t("operations.settings.refundLimit")} {business.currency}</label><input id="refund-limit" type="number" min="0.01" max="1000000" step="0.01" required value={limit} onChange={event => setLimit(event.target.value)} /><label htmlFor="duplicate-window">{t("operations.settings.duplicateWindow")}</label><input id="duplicate-window" type="number" min="1" max="1440" step="1" required value={windowMinutes} onChange={event => setWindowMinutes(event.target.value)} /><div className="required-approval"><Icon name="lock" /><div><strong>{t("operations.settings.refundApproval")}</strong><p>{t("operations.settings.requiredApprovalHint")}</p></div></div></section><RuntimeDetails token={token} /></div>
    </div>{Boolean(error) && <ErrorNotice error={error}> {t("operations.settings.versionConflictHint")}</ErrorNotice>}<div className="settings-save"><span className="muted">{dirty ? t("operations.common.unsaved") : t("operations.settings.allSaved")} · v{settings.version}</span><button className="primary" type="submit" disabled={!dirty || busy}>{busy ? t("operations.common.saving") : t("operations.settings.save")}</button></div>
  </form>
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

function RuntimeDetails({ token }: { token: string }) {
  const { t, locale } = useI18n()
  const resource = useResource<{ runtime: string; provider: string; model: string; persistence: string; paymentProvider: string; credentialsConfigured: boolean; knowledgeSearch: string; maxToolCalls: number }>('/capabilities', token, 15000)
  const data = resource.data
  return <section className="card padded"><h2>{t("operations.runtime.title")}</h2>{data ? <><div className="integration-row"><Icon name="spark" /><div><strong>{data.runtime === 'dsh' ? 'DeepSeek Harness' : t("operations.runtime.rules")}</strong><small>{data.provider} · {data.model}</small><small>{data.credentialsConfigured ? t("operations.runtime.credentialsReady") : t("operations.runtime.noModelKey")}</small></div><Badge value={data.runtime === 'dsh' ? 'llm' : 'fallback'}>{data.runtime === 'dsh' ? 'DSH' : t('operations.runtime.ruleMode')}</Badge></div><div className="integration-row"><Icon name="book" /><div><strong>{t("operations.runtime.storage")} {data.persistence === 'postgres' ? 'PostgreSQL' : t("operations.runtime.memory")}</strong><small>{data.persistence === 'memory' ? t("operations.runtime.ephemeral") : t("operations.runtime.persistent")}</small><small>{t("operations.runtime.knowledgeSearch")} {data.knowledgeSearch === 'hybrid' ? t("operations.runtime.hybrid") : data.knowledgeSearch === 'lexical' ? t("operations.runtime.lexical") : data.knowledgeSearch}{t("operations.runtime.callLimit")} {formatNumber(data.maxToolCalls, locale)}.</small></div></div></> : <p className="muted">{resource.error || t("operations.runtime.loading")}</p>}<div className="integration-row"><Icon name="lock" /><div><strong>{t("operations.runtime.payments")}</strong><small>{t("operations.runtime.simulatedProvider")}</small></div><Badge value="draft">{t("operations.runtime.simulation")}</Badge></div><p className="field-hint">{t("operations.runtime.secretBoundary")}</p></section>
}
