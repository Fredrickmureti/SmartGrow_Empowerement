/**
 * replayPolicy — pure decision rule for "should this scan auto-apply OR
 * land in a review queue?" (Plan P2).
 *
 * Background: the phone's `replayQueue` drains all buffered scans on
 * reconnect. Auto-applying every stale scan to a `doc_author` workspace
 * (Sales invoice draft) mid-edit is exactly the "rapid qty increment"
 * complaint that motivated the entire scan-semantics audit.
 *
 * The decision is desk-side and intent-aware:
 *
 *   - pos_sell           → always auto_apply (POS cart by design)
 *   - identity           → always auto_apply (code IS the payload)
 *   - doc_author         → auto_apply only if "live"; stale → review_queue
 *   - inventory_count    → auto_apply only if "live"; stale → review_queue
 *   - inventory_receive  → auto_apply only if "live"; stale → review_queue
 *
 * "Live" = `decoded_at` is within `LIVE_WINDOW_MS` of receive time. If
 * the phone did not stamp `decoded_at` we treat the scan as live (no
 * evidence of staleness — never punish a missing field).
 */

import type { ScanIntent } from "@/services/pos/scanRouter";

export type ReplayPolicy = "auto_apply" | "review_queue";

/** Stale threshold. Tuned for: a slow shop counter < 2 s round-trip. */
export const LIVE_WINDOW_MS = 2_000;

export interface DecideReplayInput {
  intent: ScanIntent | undefined;
  /** Phone decode wall-clock. Undefined ⇒ assume live. */
  decodedAt: number | undefined;
  /** Desk receive wall-clock. */
  receivedAt: number;
}

export function decideReplayPolicy(input: DecideReplayInput): ReplayPolicy {
  const { intent, decodedAt, receivedAt } = input;

  // Live scans always auto-apply. No queue-induced surprises while
  // typing — only stale replays land in review.
  const ageMs = decodedAt == null ? 0 : Math.max(0, receivedAt - decodedAt);
  const isLive = ageMs <= LIVE_WINDOW_MS;

  switch (intent) {
    case "pos_sell":
    case "identity":
    case undefined:
      return "auto_apply";
    case "doc_author":
    case "inventory_count":
    case "inventory_receive":
      return isLive ? "auto_apply" : "review_queue";
  }
}
