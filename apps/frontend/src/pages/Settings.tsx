import { useState } from 'react'
import { AppLink } from '../components/AppLink'
import { DatabaseInvestigationPanel } from '../components/DatabaseInvestigationPanel'
import { ErrorNotice } from '../components/ErrorNotice'
import { GuardsPanel } from '../components/GuardsPanel'
import { SkillsPanel } from '../components/SkillsPanel'
import { WorkspaceProvider, type WorkspaceBusiness } from '../components/WorkspaceProvider'
import { Badge, Empty, Icon, Notice } from '../components/ui'
import { formatNumber, formatPercent, useI18n } from '../i18n'
import { accents, currentAccent, setAccent } from '../lib/accent'
import { request, toolLabel, type ClassificationConfig } from '../lib/api'
import { useAppLocation } from '../lib/navigation'
import { useDirtyForm } from '../lib/useDirtyForm'
import { useResource } from '../lib/useResource'

const sections = [
  { id: 'appearance', icon: 'palette' },
  { id: 'actions', icon: 'spark' },
  { id: 'guards', icon: 'lock' },
  { id: 'data', icon: 'key' },
  { id: 'skills', icon: 'book' },
  { id: 'classification', icon: 'inbox' },
  { id: 'runtime', icon: 'settings' },
] as const

type SettingsSection = typeof sections[number]['id']
type BusinessSection = Exclude<SettingsSection, 'appearance'>

interface SettingsData {
  version: number
  language: string
  tone: string
  refundLimitCents: number
  duplicateWindowMinutes: number
  enabledTools: string[]
  classification?: ClassificationConfig | null
}

export function Settings({ token }: { token: string }) {
  const { t } = useI18n()
  const location = useAppLocation()
  const selected = new URL(location, window.location.origin).searchParams.get('section')
  const active = sections.find(section => section.id === selected)

  if (!active) {
    return <div className="settings-layout settings-overview">
      <h1 className="sr-only">{t('operations.settings.title')}</h1>
      <nav className="settings-navigation" aria-label={t('operations.settings.title')}>
        {sections.map(({ id, icon }) => (
          <AppLink key={id} className="settings-nav-item" data-section={id} href={`/operator/settings?section=${id}`}>
            <span className="settings-nav-icon"><Icon name={icon} size={18} /></span>
            <span>{t(`operations.settings.sections.${id}`)}</span>
            <span className="settings-nav-arrow"><Icon name="arrow" size={16} /></span>
          </AppLink>
        ))}
      </nav>
    </div>
  }

  const section = active.id
  return <div className="settings-layout settings-detail">
    <header className="settings-detail-header">
      <AppLink className="settings-back" href="/operator/settings">
        <Icon name="arrow" size={18} />
        {t('operations.settings.title')}
      </AppLink>
      <h1 className="sr-only">{t(`operations.settings.sections.${section}`)}</h1>
    </header>
    {section === 'appearance'
      ? <AppearanceSettings />
      : <WorkspaceProvider token={token}>{business => (
        <div className="settings-content" key={`${business.id}:${section}`}>
          <SectionContent section={section} token={token} business={business} />
        </div>
      )}</WorkspaceProvider>}
  </div>
}

function AppearanceSettings() {
  const { t } = useI18n()
  const [selected, setSelected] = useState(currentAccent)

  return <section className="card padded">
    <fieldset className="accent-picker" aria-describedby="accent-hint">
      <legend>{t('operations.settings.accent.title')}</legend>
      <p id="accent-hint" className="muted">{t('operations.settings.accent.hint')}</p>
      <div className="accent-options">
        {accents.map(accent => (
          <label className="accent-option" key={accent}>
            <input className="sr-only" type="radio" name="eldhall-accent" value={accent} checked={selected === accent} onChange={() => {
              setAccent(accent)
              setSelected(accent)
            }} />
            <span className="accent-choice" data-accent={accent}>
              <span className="accent-swatch" aria-hidden="true">
                {selected === accent && <Icon name="check" size={15} />}
              </span>
              <span>{t(`operations.settings.accent.${accent}`)}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  </section>
}

function SectionContent({ section, token, business }: { section: BusinessSection; token: string; business: WorkspaceBusiness }) {
  switch (section) {
    case 'guards': return <GuardsPanel token={token} businessId={business.id} />
    case 'data': return <DatabaseInvestigationPanel token={token} businessId={business.id} />
    case 'skills': return <SkillsPanel token={token} businessId={business.id} />
    case 'runtime': return <RuntimeDetails token={token} />
    default: return <SettingsPreferences section={section} token={token} business={business} />
  }
}

function SettingsPreferences({ section, token, business }: { section: 'actions' | 'classification'; token: string; business: WorkspaceBusiness }) {
  const { t } = useI18n()
  const path = `/settings?businessId=${encodeURIComponent(business.id)}`
  const resource = useResource<SettingsData>(path, token)
  const [saved, setSaved] = useState(false)

  return <>
    {resource.error && <ErrorNotice error={resource.errorCause}>
      <button type="button" onClick={resource.refresh}>{t('operations.common.refresh')}</button>
    </ErrorNotice>}
    {saved && <Notice>{t('operations.settings.saved')}</Notice>}
    {resource.data
      ? section === 'classification'
        ? <ClassificationDetails classification={resource.data.classification} />
        : <SettingsEditor
          key={resource.data.version}
          settings={resource.data}
          currency={business.currency}
          token={token}
          path={path}
          onSaved={() => { setSaved(true); resource.refresh() }}
        />
      : <section className="card"><Empty icon="settings" title={t(resource.loading ? 'operations.settings.loading' : 'operations.settings.unavailable')} /></section>}
  </>
}

function SettingsEditor({ settings, currency, token, path, onSaved }: {
  settings: SettingsData; currency: string; token: string; path: string; onSaved: () => void
}) {
  const { t } = useI18n()
  const [limit, setLimit] = useState(String(settings.refundLimitCents / 100))
  const [windowMinutes, setWindowMinutes] = useState(String(settings.duplicateWindowMinutes))
  const [tools, setTools] = useState(settings.enabledTools)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const refundLimitCents = Math.round(Number(limit) * 100)
  const duplicateWindowMinutes = Number(windowMinutes)
  const dirty = refundLimitCents !== settings.refundLimitCents || duplicateWindowMinutes !== settings.duplicateWindowMinutes || JSON.stringify(tools) !== JSON.stringify(settings.enabledTools)
  useDirtyForm(dirty)

  async function save() {
    if (!dirty || busy) return
    setBusy(true)
    setError(null)
    try {
      await request(path, token, {
        method: 'PATCH',
        body: { version: settings.version, language: settings.language, tone: settings.tone, requireApproval: true, refundLimitCents, duplicateWindowMinutes, enabledTools: tools },
      })
      onSaved()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  return <form className="settings-form settings-form-actions" onSubmit={event => { event.preventDefault(); void save() }}>
        <section className="card padded">
          <h2>{t('operations.settings.allowedTools')}</h2>
          <p className="muted">{t('operations.settings.toolsPolicyHint')}</p>
          {(['lookup_payments', 'refund_payment', 'escalate_to_human'] as const).map(tool => (
            <label className="check-option" key={tool}>
              <input type="checkbox" checked={tools.includes(tool)} onChange={event => {
                const checked = event.target.checked
                setTools(previous => checked ? [...previous, tool] : previous.filter(item => item !== tool))
              }} />
              <span>{toolLabel(tool, t)}<small>{t(toolHints[tool])}</small></span>
            </label>
          ))}
        </section>
        <section className="card padded">
          <h2>{t('operations.settings.actionRules')}</h2>
          <p className="muted">{t('operations.settings.recheckedBeforeExecution')}</p>
          <div className="settings-fields">
            <div className="settings-field">
              <label htmlFor="refund-limit">{t('operations.settings.refundLimit')} {currency}</label>
              <input id="refund-limit" type="number" min="0.01" max="1000000" step="0.01" required value={limit} onChange={event => setLimit(event.target.value)} />
            </div>
            <div className="settings-field">
              <label htmlFor="duplicate-window">{t('operations.settings.duplicateWindow')}</label>
              <input id="duplicate-window" type="number" min="1" max="1440" step="1" required value={windowMinutes} onChange={event => setWindowMinutes(event.target.value)} />
            </div>
          </div>
          <div className="required-approval">
            <Icon name="lock" />
            <div><strong>{t('operations.settings.refundApproval')}</strong><p>{t('operations.settings.requiredApprovalHint')}</p></div>
          </div>
        </section>
    {error !== null && <ErrorNotice error={error}>{t('operations.settings.versionConflictHint')}</ErrorNotice>}
    <div className="settings-save">
      <span className="muted">{t(dirty ? 'operations.common.unsaved' : 'operations.settings.allSaved')} · v{settings.version}</span>
      <button className="primary" type="submit" disabled={!dirty || busy}>{t(busy ? 'operations.common.saving' : 'operations.settings.save')}</button>
    </div>
  </form>
}

const toolHints = {
  lookup_payments: 'operations.settings.readPayments',
  refund_payment: 'operations.settings.approvedFinancialAction',
  escalate_to_human: 'operations.settings.humanHandoff',
} as const

function ClassificationDetails({ classification }: { classification: SettingsData['classification'] }) {
  const { t, locale } = useI18n()
  return <section className="card padded">
    <h2>{t('operations.settings.classification')}</h2>
    {classification ? <>
      <p className="muted">{t('operations.settings.businessRevision')} {classification.revision}{t('operations.settings.classificationEditing')}</p>
      <p>{t('operations.settings.confidenceThreshold')} {formatPercent(classification.minimumConfidence, locale)}{t('operations.settings.thresholdHint')}</p>
      <ul>{classification.classes.map(item => (
        <li key={item.id}>
          <strong className="break-word">{item.label}</strong>{' '}
          <small className="muted">ID {item.id}{item.id === classification.fallbackClassId ? t('operations.settings.fallbackClass') : ''}</small>
          <p className="small">{item.description}</p>
        </li>
      ))}</ul>
    </> : <p className="muted">{t('operations.settings.noClasses')}</p>}
  </section>
}

function RuntimeDetails({ token }: { token: string }) {
  const { t, locale } = useI18n()
  const resource = useResource<{ runtime: string; provider: string; model: string; persistence: string; credentialsConfigured: boolean; knowledgeSearch: string; maxToolCalls: number }>('/capabilities', token, 15000)
  const data = resource.data
  const searchLabel = data?.knowledgeSearch === 'hybrid' ? t('operations.runtime.hybrid')
    : data?.knowledgeSearch === 'lexical' ? t('operations.runtime.lexical') : data?.knowledgeSearch

  return <section className="card padded">
    <h2>{t('operations.runtime.title')}</h2>
    {resource.error && <ErrorNotice error={resource.errorCause}>
      <button type="button" onClick={resource.refresh}>{t('operations.common.refresh')}</button>
    </ErrorNotice>}
    {data ? <>
      <div className="integration-row">
        <Icon name="spark" />
        <div>
          <strong>{data.runtime === 'dsh' ? 'DeepSeek Harness' : t('operations.runtime.rules')}</strong>
          <small>{data.provider} · {data.model}</small>
          <small>{t(data.credentialsConfigured ? 'operations.runtime.credentialsReady' : 'operations.runtime.noModelKey')}</small>
        </div>
        <Badge value={data.runtime === 'dsh' ? 'llm' : 'fallback'}>{data.runtime === 'dsh' ? 'DSH' : t('operations.runtime.ruleMode')}</Badge>
      </div>
      <div className="integration-row">
        <Icon name="book" />
        <div>
          <strong>{t('operations.runtime.storage')} {data.persistence === 'postgres' ? 'PostgreSQL' : t('operations.runtime.memory')}</strong>
          <small>{t(data.persistence === 'memory' ? 'operations.runtime.ephemeral' : 'operations.runtime.persistent')}</small>
          <small>{t('operations.runtime.knowledgeSearch')} {searchLabel}{t('operations.runtime.callLimit')} {formatNumber(data.maxToolCalls, locale)}.</small>
        </div>
      </div>
    </> : resource.loading && <p className="muted">{t('operations.runtime.loading')}</p>}
    <div className="integration-row">
      <Icon name="lock" />
      <div><strong>{t('operations.runtime.payments')}</strong><small>{t('operations.runtime.simulatedProvider')}</small></div>
      <Badge value="draft">{t('operations.runtime.simulation')}</Badge>
    </div>
    <p className="field-hint">{t('operations.runtime.secretBoundary')}</p>
  </section>
}
