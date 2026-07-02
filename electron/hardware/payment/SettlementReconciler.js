"use strict";
/**
 * SettlementReconciler — EOD batch close for approved-but-uncaptured
 * authorizations. Runs on `app.ready` (warm boot) and can be re-run on
 * the `pos_outbox` replay tick.
 *
 * Approach mirrors Stripe Terminal's automatic capture cron / Adyen's
 * batch close: any row in `approved` state with `auto_capture=1` older
 * than the configurable threshold (default 24h) is captured. The single
 * point of truth is `pos_payment_terminal_log`; the FSM transitions are
 * journaled in-place.
 *
 * Concurrency: rows are processed sequentially per call. Multiple
 * reconciler invocations are safe because `PaymentService.capture()`
 * short-circuits when the row is already `captured/settled`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettlementReconciler = void 0;
class SettlementReconciler {
    constructor(opts) {
        this.opts = opts;
    }
    async runOnce() {
        const now = (this.opts.now ?? (() => Date.now()))();
        const cutoff = now - (this.opts.thresholdMs ?? 24 * 60 * 60 * 1000);
        const rows = this.opts.store.listApprovedOlderThan(cutoff);
        const out = { scanned: rows.length, captured: 0, failed: 0 };
        for (const row of rows) {
            if (!row.auth_id) {
                out.failed++;
                continue;
            }
            try {
                const r = await this.opts.service.capture(row.auth_id);
                if (r.ok)
                    out.captured++;
                else
                    out.failed++;
            }
            catch (err) {
                out.failed++;
                this.opts.logger?.error?.(`[settlement] capture failed for ${row.auth_id}: ${err.message}`);
            }
        }
        if (out.captured || out.failed) {
            this.opts.logger?.info?.(`[settlement] scanned=${out.scanned} captured=${out.captured} failed=${out.failed}`);
        }
        return out;
    }
}
exports.SettlementReconciler = SettlementReconciler;
//# sourceMappingURL=SettlementReconciler.js.map