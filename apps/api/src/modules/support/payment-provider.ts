// Simulated payment provider. It moves no real money; every result is labelled simulated.
export interface RefundRequest { paymentId: string; amountCents: number; currency: string; idempotencyKey: string }
export interface PaymentProvider { refund(request: RefundRequest): Promise<{ providerRef: string; simulated: true }> }

export class ProviderError extends Error {}

export class SimulatedPaymentProvider implements PaymentProvider {
  /** Payment ids whose refund will fail — used by tests and the failure demo. */
  readonly failing = new Set<string>();
  private readonly issued = new Map<string, string>();

  async refund(request: RefundRequest) {
    if (this.failing.has(request.paymentId)) throw new ProviderError('Simulated provider declined the refund (timeout from acquirer)');
    const existing = this.issued.get(request.idempotencyKey);
    if (existing) return { providerRef: existing, simulated: true as const };
    const providerRef = `SIM-RF-${request.idempotencyKey.slice(0, 8).toUpperCase()}`;
    this.issued.set(request.idempotencyKey, providerRef);
    return { providerRef, simulated: true as const };
  }
}
