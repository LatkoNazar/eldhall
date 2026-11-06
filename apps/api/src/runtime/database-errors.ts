import { DatabaseInvestigationError } from '../modules/database/contracts.js';

/** Model-visible repairs contain fixed profile guidance, never PostgreSQL errors or SQL literals. */
export function databaseGatewayError(error: unknown): { error: string; reasonCode: string } | null {
  if (!(error instanceof DatabaseInvestigationError)) return null;
  if (error.code === 'invalid_query') return {
    reasonCode: error.code,
    error: 'Unsupported database query. Use one SELECT over describe_database tables. For totals, use GROUP BY existing status/currency columns with COUNT(*) or SUM(column). No CASE, FILTER, casts, CTEs or custom functions. Use safe integer literals; compare exact decimals as quoted strings.',
  };
  if (error.code === 'limit_exceeded') return { reasonCode: error.code, error: 'Database read budget exceeded. Stop querying this turn; report that the investigation is incomplete.' };
  if (error.code === 'scope_unavailable') return { reasonCode: error.code, error: 'Customer-scoped database data is unavailable. Do not guess customer identifiers or broaden the scope.' };
  return { reasonCode: error.code, error: 'Database investigation is unavailable for this request. Do not claim that the requested data was verified.' };
}
