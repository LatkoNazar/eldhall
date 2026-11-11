import type { Customer } from './contracts.js';
import { seedData } from './seed.js';

type Identity = Pick<Customer, 'id' | 'businessId' | 'email'>;
export type CaseEnvironment = 'live' | 'test';

const bankBusinessId = 'b1000000-0000-4000-8000-000000000001';
const bankFixtures: Identity[] = ['olena', 'taras', 'iryna', 'marta', 'andrii', 'sofia'].map((name, index) => ({
  id: `b2000000-0000-4000-8000-00000000000${index + 1}`,
  businessId: bankBusinessId,
  email: `${name}@bank.example.test`,
}));
// Match complete server-owned fixture identities, never a browser flag or email suffix.
const fixtures: readonly Identity[] = [...seedData().customers, ...bankFixtures];

export function isDemoCustomer(customer: Identity | undefined | null): boolean {
  return !!customer && fixtures.some(fixture =>
    fixture.id === customer.id && fixture.businessId === customer.businessId && fixture.email === customer.email);
}

export const testChatStarted = 'case.test_chat_started';
/** Origin is recorded by the server when the case is created. c is the case alias. */
export const testCaseSql = `EXISTS (
  SELECT 1 FROM support_audit_events origin
  WHERE origin.case_id=c.id AND origin.type='${testChatStarted}'
)`;
