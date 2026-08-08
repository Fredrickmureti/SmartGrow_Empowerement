import { describe, it, expect } from "vitest";
import {
  ESTIMATE_TRANSITIONS,
  canTransition,
  isTerminalEstimateStatus,
  computeEstimateTotals,
} from "@/lib/estimateLifecycle";

describe("estimate lifecycle transitions", () => {
  it("allows the canonical happy path", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("sent", "viewed")).toBe(true);
    expect(canTransition("viewed", "accepted")).toBe(true);
    expect(canTransition("accepted", "converted")).toBe(true);
  });

  it("rejects reopening terminal states", () => {
    expect(canTransition("converted", "draft")).toBe(false);
    expect(canTransition("rejected", "accepted")).toBe(false);
    expect(isTerminalEstimateStatus("converted")).toBe(true);
    expect(isTerminalEstimateStatus("rejected")).toBe(true);
  });

  it("rejects skipping straight to converted", () => {
    expect(canTransition("draft", "converted")).toBe(false);
    expect(canTransition("sent", "converted")).toBe(false);
  });

  it("never lets a non-accepted estimate reach converted", () => {
    for (const [from, targets] of Object.entries(ESTIMATE_TRANSITIONS)) {
      if (from !== "accepted") expect(targets).not.toContain("converted");
    }
  });
});

describe("computeEstimateTotals", () => {
  const items = [
    { line_total: 100, tax_amount: 16 },
    { line_total: 50, tax_amount: 8 },
  ];
  const costs = [{ amount: 25, tax_amount: 4 }];

  it("keeps additional costs out of subtotal but inside total", () => {
    const t = computeEstimateTotals(items, costs, 0);
    expect(t.subtotal).toBe(150);
    expect(t.tax_amount).toBe(28);
    expect(t.total).toBe(203);
  });

  it("applies the header discount once", () => {
    expect(computeEstimateTotals(items, costs, 3).total).toBe(200);
  });

  it("is stable across create/edit round-trips", () => {
    const first = computeEstimateTotals(items, costs, 0);
    const second = computeEstimateTotals(items, costs, 0);
    expect(second).toEqual(first);
  });

  it("treats missing costs as zero, not as a price change", () => {
    expect(computeEstimateTotals(items, [], 0).total).toBe(174);
  });
});
