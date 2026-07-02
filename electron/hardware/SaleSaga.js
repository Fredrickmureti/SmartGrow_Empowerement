"use strict";
/**
 * SaleSaga — atomic sale-completion orchestration with crash recovery.
 *
 * On `sale:committed`, writes 4 outbox rows (print_receipt, open_drawer,
 * update_display, post_gl), enqueues the matching commands on
 * {@link CommandQueue}, and updates the outbox row when the queue
 * confirms terminal state. On app start, `replayUnfinished()` re-issues
 * commands for any outbox row whose step is still `pending` / `running` /
 * `failed`, restoring receipts lost to a mid-sale crash.
 *
 * Renderer code never touches this class directly — it fires
 * `pos:sale-committed` via `window.pos.sale.committed(payload)` and the
 * saga takes over.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryPayloadStore = exports.InMemoryOutboxStore = exports.SaleSaga = exports.LEGACY_POST_GL_KEY = exports.STEP_TO_ROLE_OP = void 0;
const STEP_ORDER = ['print_receipt', 'open_drawer', 'update_display', 'post_gl'];
exports.STEP_TO_ROLE_OP = {
    print_receipt: { role: 'receipt_printer', op: 'print_receipt' },
    open_drawer: { role: 'cash_drawer', op: 'open' },
    update_display: { role: 'customer_display', op: 'update' },
    // Track P (ADR-0014) — post_gl is saga housekeeping, not a payment
    // terminal vendor op. Routes through the synthetic 'saga' role; the
    // handler in `handlers/index.ts` ack's it and the renderer's
    // Supabase write performs the actual GL posting.
    post_gl: { role: 'saga', op: 'post_gl' },
};
/** Legacy outbox rows enqueued before Track P used `payment_terminal:post_gl`. */
exports.LEGACY_POST_GL_KEY = 'payment_terminal:post_gl';
class SaleSaga {
    constructor(store, queue, payloads = new InMemoryPayloadStore(), now = () => Date.now()) {
        this.store = store;
        this.queue = queue;
        this.payloads = payloads;
        this.now = now;
    }
    /** Swap the payload store (e.g. when SQLite becomes available post-login). */
    setPayloadStore(next) {
        // Drain in-memory rows into the durable store before swapping.
        for (const [saleId, payload] of this.payloads.all()) {
            try {
                next.put(saleId, payload);
            }
            catch { /* duplicate is fine */ }
        }
        this.payloads = next;
    }
    /** Called on the `pos:sale-committed` IPC message. */
    commit(payload) {
        const ts = this.now();
        // Persist the original payload FIRST so crash-recovery has the data
        // even if the outbox writes succeed but the process dies before any
        // step completes.
        try {
            this.payloads.put(payload.saleId, payload);
        }
        catch { /* idempotent put */ }
        for (const step of STEP_ORDER) {
            const stepPayload = this.payloadFor(step, payload);
            if (stepPayload === undefined)
                continue; // step opted-out for this sale
            this.store.upsert({
                sale_id: payload.saleId,
                step,
                status: 'pending',
                attempts: 0,
                last_error: null,
                created_at: ts,
            });
            const target = exports.STEP_TO_ROLE_OP[step];
            this.queue.enqueue({
                role: target.role,
                op: target.op,
                payload: stepPayload,
                idempotencyKey: `${payload.saleId}:${step}`,
            });
        }
    }
    /**
     * Mark a step as advanced based on the queue's terminal state. Called by
     * the queue worker via the EventBroker bridge in production; tests call
     * it directly.
     */
    advance(saleId, step, status, error) {
        this.store.update(saleId, step, {
            status,
            last_error: error ?? null,
        });
    }
    /**
     * On app start, re-enqueue commands for any unfinished outbox rows.
     * Idempotency keys ensure we don't print twice if the queue already has
     * the row.
     *
     * Overload kept for backwards compatibility: callers may still pass a
     * `Map<saleId, payload>` directly (tests, in-memory scenarios). When
     * omitted, the saga's own `PayloadStore` is the source of truth.
     */
    replayUnfinished(originalPayloads) {
        const lookup = originalPayloads
            ? (s) => originalPayloads.get(s) ?? null
            : (s) => this.payloads.get(s);
        const unfinished = this.store.listUnfinished();
        let replayed = 0;
        for (const row of unfinished) {
            const payload = lookup(row.sale_id);
            if (!payload)
                continue; // payload lost — operator must intervene
            const stepPayload = this.payloadFor(row.step, payload);
            if (stepPayload === undefined)
                continue;
            const target = exports.STEP_TO_ROLE_OP[row.step];
            this.queue.enqueue({
                role: target.role,
                op: target.op,
                payload: stepPayload,
                idempotencyKey: `${row.sale_id}:${row.step}`,
            });
            replayed++;
        }
        return replayed;
    }
    payloadFor(step, p) {
        switch (step) {
            case 'print_receipt': return p.receipt;
            case 'open_drawer': return p.drawer ?? undefined;
            case 'update_display': return p.display;
            case 'post_gl': return p.gl;
        }
    }
}
exports.SaleSaga = SaleSaga;
class InMemoryOutboxStore {
    constructor() {
        this.rows = [];
        this.seq = 0;
    }
    upsert(row) {
        const existing = this.rows.find(r => r.sale_id === row.sale_id && r.step === row.step);
        if (existing)
            return existing;
        const next = { ...row, id: ++this.seq };
        this.rows.push(next);
        return next;
    }
    update(saleId, step, patch) {
        const row = this.rows.find(r => r.sale_id === saleId && r.step === step);
        if (!row)
            return;
        Object.assign(row, patch);
    }
    listUnfinished() {
        return this.rows.filter(r => r.status === 'pending' || r.status === 'running' || r.status === 'failed');
    }
    findOne(saleId, step) {
        return this.rows.find(r => r.sale_id === saleId && r.step === step) ?? null;
    }
}
exports.InMemoryOutboxStore = InMemoryOutboxStore;
class InMemoryPayloadStore {
    constructor() {
        this.rows = new Map();
    }
    put(saleId, payload) { this.rows.set(saleId, payload); }
    get(saleId) { return this.rows.get(saleId) ?? null; }
    delete(saleId) { this.rows.delete(saleId); }
    all() { return new Map(this.rows); }
}
exports.InMemoryPayloadStore = InMemoryPayloadStore;
//# sourceMappingURL=SaleSaga.js.map