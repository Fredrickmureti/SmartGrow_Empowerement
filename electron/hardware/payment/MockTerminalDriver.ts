/**
 * MockTerminalDriver — deterministic in-memory implementation of
 * {@link IPaymentTerminalDriver} for tests and dev. Approval rules are
 * fixed (not random) so the saga / state-machine tests are reproducible.
 *
 *   amountCents <= 0     → error("invalid amount")
 *   amountCents === 99    → declined("insufficient funds")
 *   amountCents === 66600 → error("terminal offline")
 *   otherwise             → approved
 *
 * Idempotency: charging the same `idempotencyKey` twice returns the
 * cached `AuthResult` from the first call. This is a property of the
 * mock driver itself — the FSM dedupe inside {@link PaymentService} is
 * independent and protects against vendor drivers that do not implement
 * idempotency natively.
 */

import type {
  AuthResult, ChargeRequest, IPaymentTerminalDriver,
} from './IPaymentTerminalDriver';

export class MockTerminalDriver implements IPaymentTerminalDriver {
  readonly vendor = 'mock';
  private cache = new Map<string, AuthResult>();
  private cancelling = false;

  reset(): void {
    this.cache.clear();
    this.cancelling = false;
  }

  async charge(req: ChargeRequest): Promise<AuthResult> {
    const cached = this.cache.get(req.idempotencyKey);
    if (cached) return cached;
    if (this.cancelling) {
      this.cancelling = false;
      const r: AuthResult = { ok: false, state: 'cancelled', reason: 'operator cancelled' };
      this.cache.set(req.idempotencyKey, r);
      return r;
    }
    let r: AuthResult;
    if (!Number.isFinite(req.amountCents) || req.amountCents <= 0) {
      r = { ok: false, state: 'error', reason: 'invalid amount' };
    } else if (req.amountCents === 99) {
      r = { ok: false, state: 'declined', reason: 'insufficient funds' };
    } else if (req.amountCents === 66_600) {
      r = { ok: false, state: 'error', reason: 'terminal offline' };
    } else {
      r = {
        ok: true,
        state: 'approved',
        authId: `${req.idempotencyKey}:auth`,
        amountCents: req.amountCents,
        currency: req.currency,
        cardBrand: 'visa',
        cardLast4: '4242',
        vendorTxnId: `mock_${req.idempotencyKey}`,
      };
    }
    this.cache.set(req.idempotencyKey, r);
    return r;
  }

  async capture(authId: string): Promise<AuthResult> {
    return { ok: true, state: 'captured', authId };
  }

  async voidAuth(authId: string): Promise<AuthResult> {
    return { ok: true, state: 'voided', authId };
  }

  async refund(authId: string, amountCents: number): Promise<AuthResult> {
    if (amountCents <= 0) {
      return { ok: false, state: 'error', authId, reason: 'invalid refund amount' };
    }
    return { ok: true, state: 'refunded', authId, amountCents };
  }

  async cancelInFlight(): Promise<void> {
    this.cancelling = true;
  }

  async getStatus(): Promise<{ ready: boolean; reason?: string }> {
    return { ready: true };
  }
}