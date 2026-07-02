/**
 * ackOutbox — desk-side outbound ACK ring buffer contract tests.
 */

import { describe, it, expect } from "vitest";
import {
  ACK_OUTBOX_MAX,
  drainAckOutbox,
  enqueueAck,
  type AckOutboxState,
  type OutboxAck,
} from "@/services/scanner/ackOutbox";

function mk(code: string, seq: number, kind: OutboxAck["kind"] = "ok"): OutboxAck {
  return { code, seq, kind, at: 0 };
}

describe("ackOutbox", () => {
  it("enqueues, drains FIFO, resets full-notice latch", () => {
    const q: OutboxAck[] = [];
    const s: AckOutboxState = { fullNoticeShown: false };
    enqueueAck(q, mk("A", 1), s);
    enqueueAck(q, mk("B", 2), s);
    enqueueAck(q, mk("C", 3), s);
    const out = drainAckOutbox(q, s);
    expect(out.map((x) => x.code)).toEqual(["A", "B", "C"]);
    expect(q).toHaveLength(0);
    expect(s.fullNoticeShown).toBe(false);
  });

  it("deduplicates identical (code, seq, kind) without growing the queue", () => {
    const q: OutboxAck[] = [];
    const s: AckOutboxState = { fullNoticeShown: false };
    const r1 = enqueueAck(q, mk("A", 1, "ok"), s);
    const r2 = enqueueAck(q, mk("A", 1, "ok"), s);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(q).toHaveLength(1);
  });

  it("allows the same code with a different seq or kind", () => {
    const q: OutboxAck[] = [];
    const s: AckOutboxState = { fullNoticeShown: false };
    enqueueAck(q, mk("A", 1, "ok"), s);
    enqueueAck(q, mk("A", 2, "ok"), s);
    enqueueAck(q, mk("A", 1, "error"), s);
    expect(q).toHaveLength(3);
  });

  it("drops oldest at the cap and fires the full-notice exactly once per episode", () => {
    const q: OutboxAck[] = [];
    const s: AckOutboxState = { fullNoticeShown: false };
    for (let i = 0; i < ACK_OUTBOX_MAX; i++) {
      enqueueAck(q, mk(`C${i}`, i), s);
    }
    const overflow = enqueueAck(q, mk("OVER", ACK_OUTBOX_MAX), s);
    expect(overflow.dropped).toBe(true);
    expect(overflow.shouldNotifyFull).toBe(true);
    const overflow2 = enqueueAck(q, mk("OVER", ACK_OUTBOX_MAX + 1), s);
    expect(overflow2.dropped).toBe(true);
    expect(overflow2.shouldNotifyFull).toBe(false);
    expect(q).toHaveLength(ACK_OUTBOX_MAX);
    drainAckOutbox(q, s);
    expect(s.fullNoticeShown).toBe(false);
  });
});