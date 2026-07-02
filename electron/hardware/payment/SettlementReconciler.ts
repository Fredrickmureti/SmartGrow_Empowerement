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

import type { PaymentService } from './PaymentService';
import type { PaymentLogStore } from './PaymentService';

export interface ReconcilerOptions {
  service: PaymentService;
  store: PaymentLogStore;
  thresholdMs?: number;
  now?: () => number;
  logger?: { info?: (m: string) => void; error?: (m: string) => void };
}

export interface ReconcilerResult {
  scanned: number;
  captured: number;
  failed: number;
}

export class SettlementReconciler {
  constructor(private readonly opts: ReconcilerOptions) {}

  async runOnce(): Promise<ReconcilerResult> {
    const now = (this.opts.now ?? (() => Date.now()))();
    const cutoff = now - (this.opts.thresholdMs ?? 24 * 60 * 60 * 1000);
    const rows = this.opts.store.listApprovedOlderThan(cutoff);
    const out: ReconcilerResult = { scanned: rows.length, captured: 0, failed: 0 };
    for (const row of rows) {
      if (!row.auth_id) { out.failed++; continue; }
      try {
        const r = await this.opts.service.capture(row.auth_id);
        if (r.ok) out.captured++;
        else out.failed++;
      } catch (err) {
        out.failed++;
        this.opts.logger?.error?.(`[settlement] capture failed for ${row.auth_id}: ${(err as Error).message}`);
      }
    }
    if (out.captured || out.failed) {
      this.opts.logger?.info?.(`[settlement] scanned=${out.scanned} captured=${out.captured} failed=${out.failed}`);
    }
    return out;
  }
}