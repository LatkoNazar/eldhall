import { useEffect, useRef, useState } from 'react'
import { AppLink } from '../components/AppLink'
import { ErrorNotice } from '../components/ErrorNotice'
import { LanguagePicker } from '../components/LanguagePicker'
import { ReadOnlyDemoBanner } from '../components/ReadOnlyDemoBanner'
import { Empty, Icon } from '../components/ui'
import type { WorkspaceBusiness } from '../components/WorkspaceProvider'
import { useI18n } from '../i18n'
import type { SupportCase } from '../lib/api'
import { useResource } from '../lib/useResource'
import { CaseWorkspace } from './Inbox'

export function TestSessions({ token, business, caseId }: { token: string; business: WorkspaceBusiness; caseId: string }) {
  const { t } = useI18n()
  const resource = useResource<SupportCase[]>('/cases?environment=test', token, 4000)
  const [search, setSearch] = useState('')
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => { title.current?.focus({ preventScroll: true }) }, [])

  return <div className="app-shell test-sessions-shell">
    <a className="skip-link" href="#main-content">{t('core.nav.skip')}</a>
    <div className="app-body">
      <header className="topbar test-sessions-toolbar">
        <div className="test-sessions-heading">
          <AppLink className="test-sessions-back" href="/chat">
            <Icon name="arrow" size={18} />{t('core.chat.backToTestChat')}
          </AppLink>
          <h1 ref={title} tabIndex={-1}>{t('core.chat.testSessions')}</h1>
        </div>
        <label className="search-field topbar-search">
          <Icon name="search" />
          <input aria-label={t('core.nav.casesSearch')} placeholder={t('core.nav.casesPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} />
        </label>
        <LanguagePicker />
      </header>
      <main className="page page-workspace" id="main-content" tabIndex={-1}>
        <ReadOnlyDemoBanner />
        {resource.error && <ErrorNotice error={resource.errorCause}>
          <button type="button" className="text-button" onClick={resource.refresh}>{t('core.common.retryRead')}</button>
        </ErrorNotice>}
        {resource.loading && <div className="card"><Empty title={t('core.inbox.loading')} /></div>}
        {resource.data && <CaseWorkspace
          key={caseId}
          token={token}
          cases={resource.data.filter(item => item.isTest === true)}
          search={search}
          actionOnly={false}
          testSessions
          businessNames={{ [business.id]: business.name }}
          onRefresh={resource.refresh}
          onChanged={resource.refresh}
        />}
      </main>
    </div>
  </div>
}
