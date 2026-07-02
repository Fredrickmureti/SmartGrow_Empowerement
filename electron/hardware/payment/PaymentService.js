"use strict";
/**
 * PaymentService — owns the {@link PaymentStateMachine} per transaction,
 * dispatches to the active {@link IPaymentTerminalDriver}, and writes
 * every transition to `pos_payment_terminal_log` for crash recovery and
 * settlement reconciliation.
 *
 * Idempotency is enforced TWICE:
 *   1. By `idempotency_key` UNIQUE in `pos_payment_terminal_log` — a
 *      repeat `charge()` returns the cached row's terminal result.
 *   2. By the vendor driver itself (mock + every real vendor we plan to
 *      integrate ships its own idempotency story).
 *
 * The DB getter is injected so this works equally in main with
 * `better-sqlite3` and in tests with an in-memory shim.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryPaymentLogStore = exports.PaymentService = void 0;
const PaymentStateMachine_1 = require("./PaymentStateMachine");
class PaymentService {
    constructor(opts) {
        this.opts = {
            driver: opts.driver,
            store: opts.store,
            broker: opts.broker,
            now: opts.now ?? (() => Date.now()),
            autoCapture: opts.autoCapture ?? true,
        };
    }
    get vendor() { return this.opts.driver.vendor; }
    swapDriver(driver) {
        this.opts.driver = driver;
    }
    async charge(req) {
        const existing = this.opts.store.findByIdempotency(req.idempotencyKey);
        if (existing) {
            // Return cached terminal result if we already settled this key.
            return {
                ok: existing.state === 'approved' || existing.state === 'captured' || existing.state === 'settled',
                state: existing.state,
                authId: existing.auth_id ?? undefined,
                vendorTxnId: existing.vendor_txn_id ?? undefined,
                amountCents: existing.amount_cents,
                currency: existing.currency,
                reason: existing.error ?? undefined,
            };
        }
        const fsm = new PaymentStateMachine_1.PaymentStateMachine(req.idempotencyKey);
        this.attachBroker(fsm);
        const ts = this.opts.now();
        fsm.transition('collecting', 'card present');
        fsm.transition('authorizing', 'sending to vendor');
        let result;
        try {
            result = await this.opts.driver.charge(req);
        }
        catch (err) {
            result = { ok: false, state: 'error', reason: err.message };
        }
        try {
            fsm.transition(result.state, result.reason);
        }
        catch { /* driver returned unreachable state; force error */
            try {
                fsm.transition('error', `unreachable state ${result.state}`);
            }
            catch { /* already terminal */ }
            result = { ok: false, state: 'error', reason: `vendor returned unreachable state ${result.state}` };
        }
        const row = {
            txn_id: req.idempotencyKey,
            pos_order_id: req.posOrderId ?? req.metadata?.posOrderId ?? null,
            vendor: this.opts.driver.vendor,
            state: fsm.state,
            amount_cents: result.amountCents ?? req.amountCents,
            currency: result.currency ?? req.currency,
            auth_id: result.authId ?? null,
            vendor_txn_id: result.vendorTxnId ?? null,
            idempotency_key: req.idempotencyKey,
            error: result.reason ?? null,
            auto_capture: this.opts.autoCapture ? 1 : 0,
            created_at: ts,
            updated_at: this.opts.now(),
        };
        this.opts.store.insert(row);
        return result;
    }
    async capture(authId) {
        const row = this.opts.store.findByAuthId(authId);
        if (!row)
            return { ok: false, state: 'error', reason: 'auth not found' };
        if (row.state === 'captured' || row.state === 'settled') {
            return { ok: true, state: row.state, authId };
        }
        if (row.state !== 'approved') {
            return { ok: false, state: 'error', reason: `cannot capture from ${row.state}` };
        }
        const r = await this.opts.driver.capture(authId);
        this.opts.store.update(row.id, {
            state: r.ok ? 'captured' : 'error',
            error: r.reason ?? null,
            updated_at: this.opts.now(),
        });
        this.publish({ txnId: row.txn_id, from: row.state, to: r.ok ? 'captured' : 'error', ts: this.opts.now(), reason: r.reason });
        return r;
    }
    async voidAuth(authId) {
        const row = this.opts.store.findByAuthId(authId);
        if (!row)
            return { ok: false, state: 'error', reason: 'auth not found' };
        if (row.state !== 'approved') {
            return { ok: false, state: 'error', reason: `cannot void from ${row.state}` };
        }
        const r = await this.opts.driver.voidAuth(authId);
        this.opts.store.update(row.id, {
            state: r.ok ? 'voided' : 'error',
            error: r.reason ?? null,
            updated_at: this.opts.now(),
        });
        return r;
    }
    async refund(authId, amountCents) {
        const row = this.opts.store.findByAuthId(authId);
        if (!row)
            return { ok: false, state: 'error', reason: 'auth not found' };
        if (row.state !== 'settled' && row.state !== 'captured') {
            return { ok: false, state: 'error', reason: `cannot refund from ${row.state}` };
        }
        const r = await this.opts.driver.refund(authId, amountCents);
        this.opts.store.update(row.id, {
            state: r.ok ? 'refunded' : 'error',
            error: r.reason ?? null,
            updated_at: this.opts.now(),
        });
        return r;
    }
    async cancelInFlight() {
        await this.opts.driver.cancelInFlight();
    }
    async getStatus() {
        return this.opts.driver.getStatus();
    }
    attachBroker(fsm) {
        if (!this.opts.broker)
            return;
        fsm.on((e) => this.publish(e));
    }
    publish(e) {
        if (!this.opts.broker)
            return;
        try {
            this.opts.broker.publish({
                type: 'payment_terminal:state',
                role: 'payment_terminal',
                ts: e.ts,
                data: { txnId: e.txnId, from: e.from, to: e.to, reason: e.reason, vendor: this.opts.driver.vendor },
            });
        }
        catch { /* swallow */ }
    }
}
exports.PaymentService = PaymentService;
// ── In-memory store (tests + pre-DB-init main) ───────────────────────────
class InMemoryPaymentLogStore {
    constructor() {
        this.rows = [];
        this.seq = 0;
    }
    findByIdempotency(key) {
        return this.rows.find(r => r.idempotency_key === key) ?? null;
    }
    insert(row) {
        const next = { ...row, id: ++this.seq };
        this.rows.push(next);
        return next;
    }
    update(id, patch) {
        const row = this.rows.find(r => r.id === id);
        if (row)
            Object.assign(row, patch);
    }
    listApprovedOlderThan(cutoffMs) {
        return this.rows.filter(r => r.state === 'approved' && r.auto_capture === 1 && r.updated_at <= cutoffMs);
    }
    findByAuthId(authId) {
        return this.rows.find(r => r.auth_id === authId) ?? null;
    }
    _all() { return [...this.rows]; }
}
exports.InMemoryPaymentLogStore = InMemoryPaymentLogStore;
//# sourceMappingURL=PaymentService.js.map