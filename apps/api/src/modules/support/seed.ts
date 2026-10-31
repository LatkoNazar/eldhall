import type { Business, Customer, Payment } from './contracts.js';

// Synthetic demo data only. Session tokens are demo personas, not credentials.
export interface SeedData { businesses: Business[]; customers: Customer[]; payments: Payment[] }

const tools = ['lookup_payments', 'refund_payment', 'escalate_to_human'];

export function seedData(): SeedData {
  const businesses: Business[] = [
    { id: '00000000-0000-4000-8000-000000000001', slug: 'novapay-fitness', name: 'NovaPay Fitness', currency: 'UAH', policy: { refundLimitCents: 200000, duplicateWindowMinutes: 10, enabledTools: tools } },
    { id: '00000000-0000-4000-8000-000000000002', slug: 'kvitka-market', name: 'Kvitka Market', currency: 'UAH', policy: { refundLimitCents: 50000, duplicateWindowMinutes: 5, enabledTools: tools } },
  ];
  const nova = businesses[0]!.id;
  const kvitka = businesses[1]!.id;
  const customers: Customer[] = [
    { id: '00000000-0000-4000-8000-000000000101', businessId: nova, name: 'Olena Kovalenko', email: 'olena@example.test', plan: 'Premium monthly', sessionToken: 'demo-olena' },
    { id: '00000000-0000-4000-8000-000000000102', businessId: nova, name: 'Taras Melnyk', email: 'taras@example.test', plan: 'Basic monthly', sessionToken: 'demo-taras' },
    { id: '00000000-0000-4000-8000-000000000103', businessId: nova, name: 'Ivan Bondar', email: 'ivan@example.test', plan: 'Annual', sessionToken: 'demo-ivan' },
    { id: '00000000-0000-4000-8000-000000000104', businessId: kvitka, name: 'Marta Shevchuk', email: 'marta@example.test', plan: 'Customer', sessionToken: 'demo-marta' },
  ];
  const payment = (n: number, customerId: string, amountCents: number, merchantRef: string, description: string, createdAt: string): Payment =>
    ({ id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`, customerId, amountCents, currency: 'UAH', merchantRef, description, status: 'captured', createdAt });
  const payments: Payment[] = [
    payment(1, customers[0]!.id, 49900, 'SUB-OCT-2026', 'Premium monthly — October', '2026-10-01T09:00:00.000Z'),
    payment(2, customers[0]!.id, 49900, 'SUB-OCT-2026', 'Premium monthly — October', '2026-10-01T09:00:40.000Z'),
    payment(3, customers[0]!.id, 49900, 'SUB-SEP-2026', 'Premium monthly — September', '2026-09-01T09:00:00.000Z'),
    payment(4, customers[1]!.id, 19900, 'SUB-OCT-2026', 'Basic monthly — October', '2026-10-01T09:05:00.000Z'),
    payment(5, customers[2]!.id, 399900, 'SUB-ANNUAL-2026', 'Annual plan', '2026-10-15T12:00:00.000Z'),
    payment(6, customers[2]!.id, 399900, 'SUB-ANNUAL-2026', 'Annual plan', '2026-10-15T12:01:10.000Z'),
    payment(7, customers[3]!.id, 12500, 'ORDER-5531', 'Order #5531', '2026-10-28T17:20:00.000Z'),
  ];
  return { businesses, customers, payments };
}
