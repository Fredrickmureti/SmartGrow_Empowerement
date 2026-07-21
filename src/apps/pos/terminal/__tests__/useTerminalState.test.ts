/**
 * Unit tests for the terminal state reducer.
 *
 * Covers every transition in
 * `docs/architecture/POS_WORKSTATION_STATES.md` §3 plus the
 * sheets-vs-workspaces guarantees in §4.
 */

import { describe, expect, it } from "vitest";
import {
  INITIAL_TERMINAL_STATE,
  SHEETS_ALLOWED_PER_PHASE,
  derivePhase,
  terminalReducer,
  type TerminalState,
} from "../useTerminalState";

const READY: TerminalState = { ...INITIAL_TERMINAL_STATE, phase: "ready", previousPhase: "idle" };
const SALE: TerminalState = { ...INITIAL_TERMINAL_STATE, phase: "sale", previousPhase: "ready" };
const TENDER: TerminalState = { ...INITIAL_TERMINAL_STATE, phase: "tender", previousPhase: "sale" };

describe("derivePhase", () => {
  it("returns idle when no shift is open", () => {
    expect(derivePhase({ hasActiveShift: false, cartHasItems: false, hasUnreadCompletion: false })).toBe("idle");
  });
  it("returns receipt when a completion is unread", () => {
    expect(derivePhase({ hasActiveShift: true, cartHasItems: false, hasUnreadCompletion: true })).toBe("receipt");
  });
  it("returns sale when cart has items", () => {
    expect(derivePhase({ hasActiveShift: true, cartHasItems: true, hasUnreadCompletion: false })).toBe("sale");
  });
  it("returns ready when shift is open and cart is empty", () => {
    expect(derivePhase({ hasActiveShift: true, cartHasItems: false, hasUnreadCompletion: false })).toBe("ready");
  });
});

describe("terminalReducer — happy path", () => {
  it("idle → ready on shiftOpened", () => {
    const next = terminalReducer(INITIAL_TERMINAL_STATE, { kind: "op", op: "shiftOpened" });
    expect(next.phase).toBe("ready");
  });
  it("sale → tender on openTender with idempotency key", () => {
    const next = terminalReducer(SALE, { kind: "op", op: "openTender", idempotencyKey: "abc" });
    expect(next.phase).toBe("tender");
    expect(next.paymentSessionIdempotencyKey).toBe("abc");
  });
  it("tender → receipt on pos.payment_completed event", () => {
    const next = terminalReducer(TENDER, {
      kind: "event",
      event: {
        id: "e1",
        type: "pos.payment_completed",
        orgId: "o",
        branchId: null,
        warehouseId: null,
        sourceDocType: "pos_transaction",
        sourceDocId: "t1",
        payload: {},
        occurredAt: new Date().toISOString(),
      },
    });
    expect(next.phase).toBe("receipt");
  });
  it("tender → sale on backToSale", () => {
    const next = terminalReducer(TENDER, { kind: "op", op: "backToSale" });
    expect(next.phase).toBe("sale");
  });
  it("receipt → ready on newSale, clearing completion", () => {
    const withCompletion: TerminalState = {
      ...INITIAL_TERMINAL_STATE,
      phase: "receipt",
      completedTransaction: { transactionId: "t", receiptNumber: null, total: 100, paidAt: "", payload: null },
    };
    const next = terminalReducer(withCompletion, { kind: "op", op: "newSale" });
    expect(next.phase).toBe("ready");
    expect(next.completedTransaction).toBeNull();
  });
});

describe("terminalReducer — side transitions", () => {
  it.each(["openReturn", "openHeld", "openHistory"] as const)("ready → %s side-transition", (op) => {
    const next = terminalReducer(READY, { kind: "op", op });
    expect(["return", "held", "history"]).toContain(next.phase);
    expect(next.previousPhase).toBe("ready");
  });
  it("closeSide returns to the previous phase", () => {
    const inReturn = terminalReducer(READY, { kind: "op", op: "openReturn" });
    const back = terminalReducer(inReturn, { kind: "op", op: "closeSide" });
    expect(back.phase).toBe("ready");
  });
  it("side transitions are rejected from tender / receipt / idle", () => {
    expect(terminalReducer(TENDER, { kind: "op", op: "openReturn" }).phase).toBe("tender");
    expect(terminalReducer(INITIAL_TERMINAL_STATE, { kind: "op", op: "openHistory" }).phase).toBe("idle");
  });
});

describe("terminalReducer — lock overlay", () => {
  it("lock remembers previous phase and unlock restores it", () => {
    const locked = terminalReducer(SALE, { kind: "op", op: "lock" });
    expect(locked.phase).toBe("locked");
    expect(locked.activeSheet).toBe("unlock");
    const back = terminalReducer(locked, { kind: "op", op: "unlock" });
    expect(back.phase).toBe("sale");
  });
  it("lock is rejected from idle", () => {
    expect(terminalReducer(INITIAL_TERMINAL_STATE, { kind: "op", op: "lock" }).phase).toBe("idle");
  });
});

describe("terminalReducer — sheet gating", () => {
  it("rejects sheets not allowed in the current phase", () => {
    // line.discount is only legal in sale
    const next = terminalReducer(READY, { kind: "op", op: "openSheet", sheet: "line.discount" });
    expect(next.activeSheet).toBeNull();
  });
  it("accepts sheets allowed in the current phase", () => {
    const next = terminalReducer(SALE, { kind: "op", op: "openSheet", sheet: "line.discount" });
    expect(next.activeSheet).toBe("line.discount");
  });
  it("closeSheet clears activeSheet", () => {
    const opened = terminalReducer(SALE, { kind: "op", op: "openSheet", sheet: "line.discount" });
    const closed = terminalReducer(opened, { kind: "op", op: "closeSheet" });
    expect(closed.activeSheet).toBeNull();
  });
  it("every phase has an allow-list (may be empty)", () => {
    for (const list of Object.values(SHEETS_ALLOWED_PER_PHASE)) {
      expect(Array.isArray(list)).toBe(true);
    }
  });
});

describe("terminalReducer — illegal transitions are ignored", () => {
  it("openTender from ready is rejected", () => {
    expect(terminalReducer(READY, { kind: "op", op: "openTender" }).phase).toBe("ready");
  });
  it("backToSale from receipt is rejected", () => {
    const receipt: TerminalState = { ...INITIAL_TERMINAL_STATE, phase: "receipt" };
    expect(terminalReducer(receipt, { kind: "op", op: "backToSale" }).phase).toBe("receipt");
  });
  it("unknown events are ignored", () => {
    const next = terminalReducer(SALE, {
      kind: "event",
      event: {
        id: "x",
        type: "warehouse.task.assigned",
        orgId: "o",
        branchId: null,
        warehouseId: null,
        sourceDocType: "wms_task",
        sourceDocId: "w1",
        payload: {},
        occurredAt: "",
      },
    });
    expect(next).toBe(SALE);
  });
});
