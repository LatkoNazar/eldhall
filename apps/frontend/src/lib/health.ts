export const serviceNames = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
} as const

export type Service = keyof typeof serviceNames

export interface Readiness {
  status: 'ok' | 'unavailable'
  dependencies: Record<Service, string>
}

function isReadiness(value: unknown): value is Readiness {
  if (typeof value !== 'object' || value === null) return false
  if (!('status' in value) || (value.status !== 'ok' && value.status !== 'unavailable')) return false
  if (!('dependencies' in value) || typeof value.dependencies !== 'object' || value.dependencies === null) return false
  const dependencies = value.dependencies as Record<string, unknown>
  return Object.keys(serviceNames).every(
    (key) => typeof dependencies[key] === 'string',
  )
}

export async function fetchReadiness(signal: AbortSignal): Promise<Readiness> {
  const response = await fetch('/health/ready', {
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!response.ok && response.status !== 503) throw new Error('Readiness request failed')
  const value: unknown = await response.json()
  if (!isReadiness(value)) throw new Error('Invalid readiness response')
  return value
}
