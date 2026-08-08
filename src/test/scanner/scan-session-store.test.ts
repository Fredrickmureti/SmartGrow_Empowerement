/**
 * Locked behaviour for the Sales Scan Session state machine.
 * These are the invariants an operator on a rugged phone depends on.
 */
import { describe, expect, it } from "vitest";
import {
  emptyScanSession,
  scanSessionReducer,
  scanSessionTotals,
  scanSessionCommitEntries,
  deserializeScanSession,
  serializeScanSession,
  type ScanSessionState,
} from "@/features/sales/scan-session/scanSessionStore";
import type { ResolvedScan } from "@/hooks/pos/useResolveBarcode";

function resolved(over: Partial<ResolvedScan> = {}): ResolvedScan {
  return {
    productId: "p1",
    name: "Widget",
    sku: "W-1",
    sellingPrice: 100,
    costPrice: null,
    taxRate: 16,
    taxRateId: null,
    taxRateName: null,
    etimsTaxCode: null,
    categoryId: null,
    categoryName: null,
    branchOnHand: 5,
    matchedKind: "gtin",
    matchedCode: "123",
    matchedRuleKind: null,
    scanQuantity: 1,
    scanWeight: null,
    embeddedPrice: null,
    isWeighted: false,
    packagingId: null,
    ...over,
  } as ResolvedScan;
}

function run(actions: Parameters<typeof scanSessionReducer>[1][]): ScanSessionState {
  return actions.reduce((s, a) => scanSessionReducer(s, a), emptyScanSession);
}

describe("scanSessionReducer", () => {
  it("adds a line on first scan and merges quantity on repeat", () => {
    const s = run([
      { type: "resolved", resolved: resolved(), at: 1 },
      { type: "resolved", resolved: resolved(), at: 2 },
    ]);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].quantity).toBe(2);
    expect(s.lines[0].scans).toBe(2);
  });

  it("honours the level-aware scanQuantity — never assumes 1", () => {
    const s = run([
      { type: "resolved", resolved: resolved({ scanQuantity: 12, packagingId: "pk1" }), at: 1 },
    ]);
    expect(s.lines[0].quantity).toBe(12);
    expect(s.lines[0].levelLabel).toBe("Pack of 12");
  });

  it("moves the most recent hit to the top", () => {
    const s = run([
      { type: "resolved", resolved: resolved({ productId: "a", name: "A" }), at: 1 },
      { type: "resolved", resolved: resolved({ productId: "b", name: "B" }), at: 2 },
      { type: "resolved", resolved: resolved({ productId: "a", name: "A" }), at: 3 },
    ]);
    expect(s.lines.map((l) => l.productId)).toEqual(["a", "b"]);
  });

  it("uses the embedded (weighed) price when present", () => {
    const s = run([
      { type: "resolved", resolved: resolved({ embeddedPrice: 250, isWeighted: true }), at: 1 },
    ]);
    expect(s.lines[0].unitPrice).toBe(250);
    expect(s.lines[0].levelLabel).toBe("Weighed");
  });

  it("queues unrecognised codes and counts repeats instead of dropping them", () => {
    const s = run([
      { type: "unknown", code: "999", reason: "Not registered", at: 1 },
      { type: "unknown", code: "999", reason: "Not registered", at: 2 },
    ]);
    expect(s.unknown).toHaveLength(1);
    expect(s.unknown[0].count).toBe(2);
  });

  it("removes a line when the quantity is stepped to zero", () => {
    const s = run([
      { type: "resolved", resolved: resolved(), at: 1 },
      { type: "setQuantity", productId: "p1", quantity: 0 },
    ]);
    expect(s.lines).toHaveLength(0);
  });

  it("undo reverts the last mutation", () => {
    const s = run([
      { type: "resolved", resolved: resolved(), at: 1 },
      { type: "resolved", resolved: resolved(), at: 2 },
      { type: "undo" },
    ]);
    expect(s.lines[0].quantity).toBe(1);
  });

  it("computes running totals for the live tally", () => {
    const s = run([
      { type: "resolved", resolved: resolved({ productId: "a", sellingPrice: 100 }), at: 1 },
      { type: "resolved", resolved: resolved({ productId: "b", sellingPrice: 50, scanQuantity: 2 }), at: 2 },
    ]);
    expect(scanSessionTotals(s)).toEqual({ lineCount: 2, unitCount: 3, value: 200 });
  });

  it("commits oldest-scanned first so line order matches picking order", () => {
    const s = run([
      { type: "resolved", resolved: resolved({ productId: "a" }), at: 10 },
      { type: "resolved", resolved: resolved({ productId: "b" }), at: 20 },
    ]);
    expect(scanSessionCommitEntries(s).map((e) => e.resolved.productId)).toEqual(["a", "b"]);
  });

  it("round-trips through storage so a backgrounded tab does not lose the cart", () => {
    const s = run([{ type: "resolved", resolved: resolved(), at: 1 }]);
    const restored = deserializeScanSession(serializeScanSession(s));
    expect(restored?.lines[0].productId).toBe("p1");
    expect(deserializeScanSession("not json")).toBeNull();
    expect(deserializeScanSession(null)).toBeNull();
  });
});
