import { describe, it, expect } from "vitest";
import {
  LOAN_TRANSITIONS,
  canTransition,
  nextStatus,
  isTerminal,
  getAvailableActions,
} from "@/lib/hr/loanStateMachine";

describe("loanStateMachine", () => {
  it("has no duplicate (from, event) pairs", () => {
    const seen = new Set<string>();
    for (const t of LOAN_TRANSITIONS) {
      const key = `${t.from}:${t.event}`;
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("enforces the linear approve → authorize → disburse chain", () => {
    expect(nextStatus("pending_approval", "approve")).toBe("approved");
    expect(nextStatus("approved", "authorize_disbursement")).toBe("awaiting_disbursement");
    expect(nextStatus("awaiting_disbursement", "disburse")).toBe("active");
    // Skipping authorize is illegal — approved cannot disburse directly.
    expect(canTransition("approved", "disburse")).toBe(false);
  });

  it("recognises terminal states", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("written_off")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("active")).toBe(false);
  });

  describe("getAvailableActions", () => {
    it("offers approve/reject/cancel from pending_approval", () => {
      const a = getAvailableActions({
        status: "pending_approval",
        outstandingBalance: 0,
        hasDisbursementJournal: false,
      });
      expect(a.has("approve")).toBe(true);
      expect(a.has("reject")).toBe(true);
      expect(a.has("cancel")).toBe(true);
      expect(a.has("disburse")).toBe(false);
    });

    it("offers authorize but not disburse from approved", () => {
      const a = getAvailableActions({
        status: "approved",
        outstandingBalance: 0,
        hasDisbursementJournal: false,
      });
      expect(a.has("authorize_disbursement")).toBe(true);
      expect(a.has("disburse")).toBe(false);
    });

    it("suppresses disburse once a disbursement JE exists (idempotent guard)", () => {
      const a = getAvailableActions({
        status: "awaiting_disbursement",
        outstandingBalance: 0,
        hasDisbursementJournal: true,
      });
      expect(a.has("disburse")).toBe(false);
    });

    it("gates settle on zero balance and write_off on positive balance", () => {
      const zero = getAvailableActions({
        status: "active",
        outstandingBalance: 0,
        hasDisbursementJournal: true,
      });
      expect(zero.has("settle")).toBe(true);
      expect(zero.has("write_off")).toBe(false);

      const owing = getAvailableActions({
        status: "active",
        outstandingBalance: 100,
        hasDisbursementJournal: true,
      });
      expect(owing.has("settle")).toBe(false);
      expect(owing.has("write_off")).toBe(true);
    });
  });
});
