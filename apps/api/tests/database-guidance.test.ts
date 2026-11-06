import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseInvestigationError } from '../src/modules/database/contracts.js';
import { databaseGatewayError } from '../src/runtime/database-errors.js';

test('SQL repairs expose a fixed supported profile without reflecting server errors or query literals', () => {
  const refused = new DatabaseInvestigationError('invalid_query');
  refused.message = 'private DSN postgres://secret@server and customer SQL literal';
  const publicError = databaseGatewayError(refused);
  assert.equal(publicError?.reasonCode, 'invalid_query');
  assert.match(publicError!.error, /GROUP BY/);
  assert.doesNotMatch(JSON.stringify(publicError), /private|postgres:|secret|customer SQL literal/);
  assert.equal(databaseGatewayError(new Error('raw database failure')), null);
  assert.equal(databaseGatewayError({ code: 'invalid_query', message: 'SQL exception lookalike' }), null);
});

test('database failures and exhausted budgets never instruct the model to broaden customer access', () => {
  for (const code of ['disabled', 'scope_unavailable', 'unavailable', 'role_not_readonly', 'limit_exceeded', 'timeout', 'cancelled', 'stale_policy'] as const) {
    const publicError = databaseGatewayError(new DatabaseInvestigationError(code));
    assert.equal(publicError?.reasonCode, code);
    assert.ok(publicError?.error);
  }
  assert.match(databaseGatewayError(new DatabaseInvestigationError('limit_exceeded'))!.error, /Stop querying/);
  assert.match(databaseGatewayError(new DatabaseInvestigationError('scope_unavailable'))!.error, /Do not guess/);
});
