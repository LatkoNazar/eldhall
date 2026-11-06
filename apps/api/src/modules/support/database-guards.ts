import { databaseInvestigationPolicySchema, DEFAULT_DATABASE_LIMITS, DATABASE_LIMIT_BOUNDS, type DatabaseInvestigationPolicy } from '../database/contracts.js';
import type { SupportSettings } from './contracts.js';

/** Identity and read-only constraints are application-owned, never editable guard settings. */
export function databaseInvestigationPolicy(value: unknown): DatabaseInvestigationPolicy {
  return databaseInvestigationPolicySchema.parse(value ?? { enabled: false, limits: DEFAULT_DATABASE_LIMITS });
}

export function databasePolicyUpdate(current: { databaseInvestigation?: DatabaseInvestigationPolicy }, next: { databaseInvestigation?: DatabaseInvestigationPolicy }) {
  const value = next.databaseInvestigation ?? current.databaseInvestigation;
  return value === undefined ? {} : { databaseInvestigation: databaseInvestigationPolicy(value) };
}

export function databaseGuardConfiguration(settings: SupportSettings, sources: { id: string; label: string; status: 'configured' }[]) {
  const policy = databaseInvestigationPolicy(settings.databaseInvestigation);
  return {
    version: settings.version, ...policy, bounds: DATABASE_LIMIT_BOUNDS,
    constraints: { readOnly: true as const, scope: 'current_customer' as const }, sources,
  };
}
