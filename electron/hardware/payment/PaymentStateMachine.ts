/**
 * PaymentStateMachine — vendor-agnostic FSM for card-present payment
 * terminals. Pure logic: no transports, no SDKs, no SQLite. Persistence
 * + driver dispatch is owned by {@link PaymentService}.
 *
 * Transition table (Square / Stripe Terminal / Adyen consensus):
 *
 *   idle        → collecting
 *   collecting  → authorizing | cancelled | error
 *   authorizing → approved | declined | error
 *   approved    → captured | voided | error
 *   captured    → settled
 *   settled     → refund_requested
 *   refund_requested → refunded | error
 *
 * Any state can move to `error` (terminal). `declined / cancelled /
 * voided / refunded / error / settled` are terminal — re-issuing the
 * same `idempotencyKey` returns the cached result.
 */

import type { TxnState } from './IPaymentTerminalDriver';

const VALID: Record<TxnState, readonly TxnState[]> = {
  idle: ['collecting', 'error'],
  collecting: ['authorizing', 'cancelled', 'error'],
  authorizing: ['approved', 'declined', 'error'],
  approved: ['captured', 'voided', 'error'],
  declined: [],
  cancelled: [],
  captured: ['settled', 'error'],
  settled: ['refund_requested'],
  voided: [],
  refund_requested: ['refunded', 'error'],
  refunded: [],
  error: [],
};

export const TERMINAL_STATES: ReadonlySet<TxnState> = new Set<TxnState>([
  'declined', 'cancelled', 'voided', 'refunded', 'error', 'settled',
]);

export function isTerminal(s: TxnState): boolean {
  return TERMINAL_STATES.has(s);
}

export function canTransition(from: TxnState, to: TxnState): boolean {
  return VALID[from]?.includes(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(public readonly from: TxnState, public readonly to: TxnState) {
    super(`invalid FSM transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface TransitionEvent {
  txnId: string;
  from: TxnState;
  to: TxnState;
  reason?: string;
  ts: number;
}

export type TransitionListener = (e: TransitionEvent) => void;

/**
 * Lightweight per-txn FSM helper. Wraps `canTransition` with a current
 * state pointer and emits events. Created per transaction by
 * {@link PaymentService}; never shared across txns.
 */
export class PaymentStateMachine {
  private _state: TxnState = 'idle';
  private listeners: TransitionListener[] = [];

  constructor(public readonly txnId: string, initial: TxnState = 'idle') {
    this._state = initial;
  }

  get state(): TxnState { return this._state; }

  on(listener: TransitionListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  /** Throws InvalidTransitionError if `to` is not reachable from current state. */
  transition(to: TxnState, reason?: string): void {
    if (!canTransition(this._state, to)) {
      throw new InvalidTransitionError(this._state, to);
    }
    const from = this._state;
    this._state = to;
    const ev: TransitionEvent = { txnId: this.txnId, from, to, reason, ts: Date.now() };
    for (const l of this.listeners) {
      try { l(ev); } catch { /* swallow */ }
    }
  }

  isTerminal(): boolean { return isTerminal(this._state); }
}