import { useEffect, useState } from 'react'
import { Badge } from './ui'
import { dateTime, errorText, request } from '../lib/api'

interface Version { id: string; version: number; status: string; title: string; content: string; updatedAt: string }

/** Every saved version of a source, so an operator can see exactly what the AI could cite and when. */
export function KnowledgeVersions({ token, businessId, sourceId, current }: { token: string; businessId: string; sourceId: string; current: number }) {
  const [versions, setVersions] = useState<Version[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    request<{ versions: Version[] }>(`/knowledge/${sourceId}/versions?businessId=${encodeURIComponent(businessId)}`, token, { signal: controller.signal })
      .then(value => { setVersions(Array.isArray(value.versions) ? value.versions : []); setError('') })
      .catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)) })
    return () => controller.abort()
  }, [token, businessId, sourceId, current])
  if (error) return <p className="muted small">Історія недоступна: {error}</p>
  if (!versions?.length) return null
  return <details className="skill-item">
    <summary>Історія версій · {versions.length}</summary>
    <ol>{versions.map(version => <li key={version.version}><details><summary>v{version.version} <Badge value={version.status} /> <small className="muted">{dateTime(version.updatedAt)}</small></summary><p className="skill-content small">{version.content}</p></details></li>)}</ol>
  </details>
}
