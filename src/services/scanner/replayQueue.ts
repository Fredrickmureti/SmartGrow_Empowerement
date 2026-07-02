/**
 * Phone-side scan replay queue (pure data structure).
 *
 * Owns the contract enforced by `MobileScannerPage.broadcastScan` while the
 * realtime channel is reconnecting / connecting:
 *
 *   - FIFO ordering on drain
 *   - Cap of MAX (default 50), drop-oldest when full
 *   - "queue-full" toast fires exactly once per saturation episode and
 *     resets after a successful drain.
 *
 * Extracted so it can be unit-tested without mounting the page component.
 */

export interface QueuedScan {
  code: string;
  seq: number;
  decoded_at: number;
}

export const REPLAY_QUEUE_MAX = 50;

export interface EnqueueResult {
  /** Did we have to drop the oldest entry to make room? */
  dropped: boolean;
  /** Should the caller surface a "queue full" toast right now? */
  shouldNotifyFull: boolean;
  /** New queue depth after the operation. */
  depth: number;
}

/**
 * Mutates `queue` in place. Returns whether a drop occurred and whether the
 * caller should fire a one-time toast.
 */
export function enqueueScan(
  queue: QueuedScan[],
  item: QueuedScan,
  state: { fullToastShown: boolean },
  max: number = REPLAY_QUEUE_MAX,
): EnqueueResult {
  let dropped = false;
  let shouldNotifyFull = false;
  if (queue.length >= max) {
    queue.shift();
    dropped = true;
    if (!state.fullToastShown) {
      state.fullToastShown = true;
      shouldNotifyFull = true;
    }
  }
  queue.push(item);
  return { dropped, shouldNotifyFull, depth: queue.length };
}

/**
 * Removes and returns all queued items in FIFO order. Resets the toast latch
 * so the next saturation can notify again.
 */
export function drainQueue(
  queue: QueuedScan[],
  state: { fullToastShown: boolean },
): QueuedScan[] {
  const out = queue.splice(0, queue.length);
  state.fullToastShown = false;
  return out;
}