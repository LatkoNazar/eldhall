import { createContext, useContext, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { useResource } from '../lib/useResource'
import { Empty, Notice } from './ui'
import { ErrorNotice } from './ErrorNotice'

export interface WorkspaceBusiness { id: string; slug: string; name: string; currency: string }
const WorkspaceContext = createContext<WorkspaceBusiness | null>(null)

/** One authenticated server binding; URL parameters never select another business. */
export function WorkspaceProvider({ token, children }: { token: string; children: (business: WorkspaceBusiness) => ReactNode }) {
  const inherited = useContext(WorkspaceContext)
  return inherited ? children(inherited) : <WorkspaceLoader key={token} token={token}>{children}</WorkspaceLoader>
}

function WorkspaceLoader({ token, children }: { token: string; children: (business: WorkspaceBusiness) => ReactNode }) {
  const { t } = useI18n()
  const resource = useResource<{ business: WorkspaceBusiness }>('/workspace', token)
  if (!resource.data || resource.error) return <section className="card padded workspace-unavailable"><Empty icon="lock" title={t(resource.loading ? 'bank.workspace.loading' : 'bank.workspace.unavailable')} />{resource.error && <ErrorNotice error={resource.errorCause}><button type="button" onClick={resource.refresh}>{t('core.common.retryRead')}</button></ErrorNotice>}</section>
  const business = resource.data.business
  const requested = new URLSearchParams(window.location.search).get('businessId')
  return <WorkspaceContext.Provider value={business}>{requested && requested !== business.id && <Notice>{t('bank.workspace.foreign')}</Notice>}{children(business)}</WorkspaceContext.Provider>
}
