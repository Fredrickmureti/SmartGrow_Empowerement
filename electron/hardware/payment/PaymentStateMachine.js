"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentStateMachine = exports.InvalidTransitionError = exports.TERMINAL_STATES = void 0;
exports.isTerminal = isTerminal;
exports.canTransition = canTransition;
const VALID = {
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
exports.TERMINAL_STATES = new Set([
    'declined', 'cancelled', 'voided', 'refunded', 'error', 'settled',
]);
function isTerminal(s) {
    return exports.TERMINAL_STATES.has(s);
}
function canTransition(from, to) {
    return VALID[from]?.includes(to) ?? false;
}
class InvalidTransitionError extends Error {
    constructor(from, to) {
        super(`invalid FSM transition: ${from} → ${to}`);
        this.from = from;
        this.to = to;
        this.name = 'InvalidTransitionError';
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
/**
 * Lightweight per-txn FSM helper. Wraps `canTransition` with a current
 * state pointer and emits events. Created per transaction by
 * {@link PaymentService}; never shared across txns.
 */
class PaymentStateMachine {
    constructor(txnId, initial = 'idle') {
        this.txnId = txnId;
        this._state = 'idle';
        this.listeners = [];
        this._state = initial;
    }
    get state() { return this._state; }
    on(listener) {
        this.listeners.push(listener);
        return () => { this.listeners = this.listeners.filter(l => l !== listener); };
    }
    /** Throws InvalidTransitionError if `to` is not reachable from current state. */
    transition(to, reason) {
        if (!canTransition(this._state, to)) {
            throw new InvalidTransitionError(this._state, to);
        }
        const from = this._state;
        this._state = to;
        const ev = { txnId: this.txnId, from, to, reason, ts: Date.now() };
        for (const l of this.listeners) {
            try {
                l(ev);
            }
            catch { /* swallow */ }
        }
    }
    isTerminal() { return isTerminal(this._state); }
}
exports.PaymentStateMachine = PaymentStateMachine;
//# sourceMappingURL=PaymentStateMachine.js.map