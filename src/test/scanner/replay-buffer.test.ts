/**
 * Scanner phone-side replay queue contract.
 *
 * Pins the FIFO + cap-50 drop-oldest + single-shot "full" toast behavior
 * that `MobileScannerPage` relies on while the realtime channel is
 * `connecting` / `reconnecting`. Desk-side `(device_id, seq)` dedupe
 * handles the rare double-SUBSCRIBED case, so the queue itself only needs
 * to guarantee ordering and bounded memory.
 */

import { describe, it, expect } from "vitest";
import {
  enqueueScan,
  drainQueue,
  REPLAY_QUEUE_MAX,
  type QueuedScan,
} from "@/services/scanner/replayQueue";

const mk = (i: number): QueuedScan => ({ code: `c${i}`, seq: i, decoded_at: i });

describe("scanner replay queue", () => {
  it("enqueues in arrival order and reports depth", () => {
    const q: QueuedScan[] = [];
    const s = { fullToastShown: false };
    expect(enqueueScan(q, mk(1), s).depth).toBe(1);
    expect(enqueueScan(q, mk(2), s).depth).toBe(2);
    expect(q.map((x) => x.seq)).toEqual([1, 2]);
  });

  it("drains FIFO and clears the queue", () => {
    const q: QueuedScan[] = [];
    const s = { fullToastShown: false };
    [1, 2, 3].forEach((i) => enqueueScan(q, mk(i), s));
    const out = drainQueue(q, s);
    expect(out.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(q.length).toBe(0);
  });

  it("drops oldest at cap and fires the full-toast exactly once", () => {
    const q: QueuedScan[] = [];
    const s = { fullToastShown: false };
    for (let i = 0; i < REPLAY_QUEUE_MAX; i++) enqueueScan(q, mk(i), s);
    expect(q.length).toBe(REPLAY_QUEUE_MAX);

    const r1 = enqueueScan(q, mk(999), s);
    expect(r1.dropped).toBe(true);
    expect(r1.shouldNotifyFull).toBe(true);
    expect(q[0].seq).toBe(1); // oldest (seq=0) dropped
    expect(q[q.length - 1].seq).toBe(999);

    const r2 = enqueueScan(q, mk(1000), s);
    expect(r2.dropped).toBe(true);
    expect(r2.shouldNotifyFull).toBe(false); // latched until drain
  });

  it("re-arms the full-toast latch after a drain", () => {
    const q: QueuedScan[] = [];
    const s = { fullToastShown: false };
    for (let i = 0; i < REPLAY_QUEUE_MAX + 1; i++) enqueueScan(q, mk(i), s);
    expect(s.fullToastShown).toBe(true);
    drainQueue(q, s);
    expect(s.fullToastShown).toBe(false);

    for (let i = 0; i < REPLAY_QUEUE_MAX + 1; i++) enqueueScan(q, mk(i + 100), s);
    const after = enqueueScan(q, mk(9999), s);
    // Already saturated again — but the toast for THIS saturation fires
    // on the first drop, which happened at i=REPLAY_QUEUE_MAX above.
    expect(s.fullToastShown).toBe(true);
    expect(after.dropped).toBe(true);
  });

  it("draining an empty queue is a no-op and does not toast", () => {
    const q: QueuedScan[] = [];
    const s = { fullToastShown: false };
    expect(drainQueue(q, s)).toEqual([]);
    expect(s.fullToastShown).toBe(false);
  });

  it("a double SUBSCRIBED cannot double-emit (second drain returns empty)", () => {
    const q: QueuedScan[] = [];
    const s = { fullToastShown: false };
    [1, 2].forEach((i) => enqueueScan(q, mk(i), s));
    const first = drainQueue(q, s);
    const second = drainQueue(q, s);
    expect(first.length).toBe(2);
    expect(second.length).toBe(0);
  });
});