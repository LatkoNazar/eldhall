export const databaseLimitBounds = {
  maxQueriesPerTurn: { min: 1, max: 12 }, timeoutMs: { min: 100, max: 5000 },
  maxRows: { min: 1, max: 200 }, maxBytes: { min: 1024, max: 65536 },
} as const
export type DatabaseLimit = keyof typeof databaseLimitBounds
export type DatabaseLimits = Record<DatabaseLimit, number>
export interface DatabaseInvestigationPolicy {
  version: number; enabled: boolean; limits: DatabaseLimits
  bounds: typeof databaseLimitBounds
  constraints: { readOnly: true; scope: 'current_customer' }
  sources: { id: string; label: string; status: 'configured' }[]
}
export const databaseLimitKeys = Object.keys(databaseLimitBounds) as DatabaseLimit[]
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
export function validDatabaseLimits(value: unknown): value is DatabaseLimits {
  return record(value) && exact(value, databaseLimitKeys) && databaseLimitKeys.every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= databaseLimitBounds[key].min && Number(value[key]) <= databaseLimitBounds[key].max)
}
export function validDatabaseInvestigationPolicy(value: unknown): value is DatabaseInvestigationPolicy {
  if (!record(value) || !exact(value, ['version', 'enabled', 'limits', 'bounds', 'constraints', 'sources']) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.enabled !== 'boolean' || !validDatabaseLimits(value.limits)) return false
  if (!record(value.bounds) || !exact(value.bounds, databaseLimitKeys) || !databaseLimitKeys.every(key => {
    const bound = (value.bounds as Record<string, unknown>)[key]
    return record(bound) && exact(bound, ['min', 'max']) && bound.min === databaseLimitBounds[key].min && bound.max === databaseLimitBounds[key].max
  })) return false
  return record(value.constraints) && exact(value.constraints, ['readOnly', 'scope']) && value.constraints.readOnly === true && value.constraints.scope === 'current_customer'
    && Array.isArray(value.sources) && value.sources.every(source => record(source) && exact(source, ['id', 'label', 'status']) && typeof source.id === 'string' && !!source.id.trim() && typeof source.label === 'string' && !!source.label.trim() && source.status === 'configured') && new Set(value.sources.map(source => source.id)).size === value.sources.length
}
