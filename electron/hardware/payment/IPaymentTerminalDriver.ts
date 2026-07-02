/**
 * IPaymentTerminalDriver — vendor-agnostic contract for EMV / contactless
 * payment terminals. Implemented by `MockTerminalDriver` (default) and,
 * in future loops, `StripeTerminalDriver` / `AdyenTerminalDriver` /
 * `VerifoneTerminalDriver`. The interface is intentionally narrower than
 * any single vendor SDK so the SaleSaga never leaks vendor types.
 *
 * Money is always handled in minor units (cents) to keep the FSM and
 * the persistence layer integer-only.
 */

export type TxnState =
  | 'idle'
  | 'collecting'
  | 'authorizing'
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'captured'
  | 'settled'
  | 'voided'
  | 'refund_requested'
  | 'refunded'
  | 'error';

export interface AuthResult {
  ok: boolean;
  state: TxnState;
  authId?: string;
  /** Cents actually authorized — may differ from request if partial-auth. */
  amountCents?: number;
  currency?: string;
  /** Last-4 / card brand / receipt fields for the customer copy. */
  cardBrand?: string;
  cardLast4?: string;
  reason?: string;
  /** Vendor-side correlation id (Stripe payment_intent, Adyen pspReference, …). */
  vendorTxnId?: string;
}

export interface ChargeRequest {
  amountCents: number;
  currency: string;
  /** Idempotency key — re-issuing the same key returns the cached result. */
  idempotencyKey: string;
  /** Free-form metadata (posOrderId, branchId, cashierId). */
  metadata?: Record<string, string>;
}

export interface IPaymentTerminalDriver {
  readonly vendor: string;
  charge(req: ChargeRequest): Promise<AuthResult>;
  capture(authId: string): Promise<AuthResult>;
  voidAuth(authId: string): Promise<AuthResult>;
  refund(authId: string, amountCents: number): Promise<AuthResult>;
  cancelInFlight(): Promise<void>;
  getStatus(): Promise<{ ready: boolean; reason?: string }>;
}
