import { useI18n, formatDateTime, formatNumber } from '../i18n'
import { ErrorNotice } from './ErrorNotice'
import { useEffect, useState } from 'react'
import { Badge } from './ui'
import { request } from '../lib/api'

interface Version { id: string; version: number; status: string; title: string; content: string; updatedAt: string }

/** Every saved version of a source, so an operator can see exactly what the AI could cite and when. */
export function KnowledgeVersions({ token, businessId, sourceId, current }: { token: string; businessId: string; sourceId: string; current: number }) {
  const { t, locale } = useI18n()
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState<unknown | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    request<{ versions: Version[] }>(`/knowledge/${sourceId}/versions?businessId=${encodeURIComponent(businessId)}`, token, { signal: controller.signal })
      .then(value => { setVersions(Array.isArray(value.versions) ? value.versions : []); setError(null) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause) })
    return () => controller.abort()
  }, [token, businessId, sourceId, current])
  if (error) return <ErrorNotice error={error}>{t('operations.knowledge.historyUnavailable')}</ErrorNotice>
  if (!versions?.length) return null
  return <details className="skill-item">
    <summary>{t("operations.knowledge.versionHistory")} {formatNumber(versions.length, locale)}</summary>
    <ol>{versions.map(version => <li key={version.version}><details><summary>v{version.version} <Badge value={version.status} /> <small className="muted">{formatDateTime(version.updatedAt, locale)}</small></summary><p className="skill-content small">{version.content}</p></details></li>)}</ol>
  </details>
}
