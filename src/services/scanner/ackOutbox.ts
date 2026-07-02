/**
 * ackOutbox — desk-side outbound ACK ring buffer.
 *
 * Mirror of `replayQueue` but for the OPPOSITE direction. When the desk
 * loses realtime mid-burst, ACKs (and the paired `log_scan_event`
 * telemetry rows the cockpit relies on) would otherwise be silently lost.
 * The two desk-side hooks (`useScanChannel`, `usePOSScannerChannel`)
 * enqueue here whenever `channelState !== "connected"` and drain FIFO
 * on the next `SUBSCRIBED`.
 *
 * Pure data structure — no Supabase / no React. Unit-tested in
 * `src/test/scanner/ack-outbox.test.ts`.
 *
 *  - FIFO ordering on drain.
 *  - Cap of `MAX` (default 100), drop-oldest when full.
 *  - Dedupe on identical `(code, seq, kind)` so a noisy resend cannot
 *    inflate the outbox.
 *  - One-shot "outbox-full" notification per saturation episode; the
 *    latch resets after a successful drain.
 */

export interface OutboxAck {
  code: string;
  seq: number;
  kind: "ok" | "weighted" | "unknown" | "error";
  detail?: string | null;
  at: number;
  workflow?: string | null;
  field_label?: string | null;
}

export const ACK_OUTBOX_MAX = 100;

export interface AckOutboxState {
  fullNoticeShown: boolean;
}

export interface EnqueueAckResult {
  /** Whether the new entry was a duplicate and skipped. */
  duplicate: boolean;
  /** Whether we had to drop the oldest entry to make room. */
  dropped: boolean;
  /** Whether the caller should fire a one-time "outbox full" notice. */
  shouldNotifyFull: boolean;
  /** New depth after the operation. */
  depth: number;
}

function sameAck(a: OutboxAck, b: OutboxAck): boolean {
  return a.code === b.code && a.seq === b.seq && a.kind === b.kind;
}

/**
 * Mutates `queue` in place. Drops duplicates first, then enforces cap.
 */
export function enqueueAck(
  queue: OutboxAck[],
  item: OutboxAck,
  state: AckOutboxState,
  max: number = ACK_OUTBOX_MAX,
): EnqueueAckResult {
  // Dedupe — silently drop if the exact same (code, seq, kind) is queued.
  for (const existing of queue) {
    if (sameAck(existing, item)) {
      return { duplicate: true, dropped: false, shouldNotifyFull: false, depth: queue.length };
    }
  }
  let dropped = false;
  let shouldNotifyFull = false;
  if (queue.length >= max) {
    queue.shift();
    dropped = true;
    if (!state.fullNoticeShown) {
      state.fullNoticeShown = true;
      shouldNotifyFull = true;
    }
  }
  queue.push(item);
  return { duplicate: false, dropped, shouldNotifyFull, depth: queue.length };
}

/** Removes and returns all queued items in FIFO order. Resets the latch. */
export function drainAckOutbox(
  queue: OutboxAck[],
  state: AckOutboxState,
): OutboxAck[] {
  const out = queue.splice(0, queue.length);
  state.fullNoticeShown = false;
  return out;
}