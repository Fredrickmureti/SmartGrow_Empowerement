import { describe, it, expect } from "vitest";
import {
  resolveLineSnapshot,
  formatLineQty,
  formatLineQtyString,
} from "@/lib/inventory/uom";

/**
 * Phase 2 — historical immutability.
 *
 * A posted line must keep rendering with the pack name, factor and base unit
 * that were true on the day it was written, even when `product_packaging` is
 * later renamed or re-specified.
 */
describe("resolveLineSnapshot", () => {
  it("prefers the frozen structured snapshot over the live packaging join", () => {
    const snap = resolveLineSnapshot({
      quantity: 50,
      display_quantity: 1,
      packaging_id: "pack-1",
      // Live pack was re-specified after the document was issued.
      packaging: { name: "Bag (small)", qty_in_base_uom: 25 },
      uom_snapshot_pack_name: "Bag",
      uom_snapshot_factor: 50,
      uom_snapshot_base_code: "KG",
    });

    expect(snap).toEqual({
      packName: "Bag",
      factor: 50,
      baseCode: "KG",
      frozen: true,
    });
  });

  it("accepts numeric strings from PostgREST numeric columns", () => {
    const snap = resolveLineSnapshot({
      quantity: 24,
      uom_snapshot_pack_name: "Carton",
      uom_snapshot_factor: "12.000",
      uom_snapshot_base_code: "ea",
    });
    expect(snap.factor).toBe(12);
    expect(snap.frozen).toBe(true);
  });

  it("falls back to the live packaging join for pre-Phase-2 rows", () => {
    const snap = resolveLineSnapshot({
      quantity: 24,
      packaging_id: "pack-1",
      packaging: { name: "Carton", qty_in_base_uom: 12 },
    });
    expect(snap).toEqual({
      packName: "Carton",
      factor: 12,
      baseCode: null,
      frozen: false,
    });
  });

  it("falls back to parsing the legacy free-text snapshot", () => {
    const snap = resolveLineSnapshot({
      quantity: 480,
      uom_snapshot: "Pallet × 480 ea",
    });
    expect(snap.packName).toBe("Pallet");
    expect(snap.frozen).toBe(false);
  });
});

describe("formatLineQty with a frozen snapshot", () => {
  it("renders the historical meaning, not the current pack definition", () => {
    const line = {
      quantity: 50,
      display_quantity: 1,
      packaging_id: "pack-1",
      packaging: { name: "Bag (small)", qty_in_base_uom: 25 },
      uom_snapshot_pack_name: "Bag",
      uom_snapshot_factor: 50,
      uom_snapshot_base_code: "KG",
    };
    expect(formatLineQtyString(line)).toBe("1 Bag (50 KG)");
  });

  it("uses the frozen base code over a caller-supplied base label", () => {
    const f = formatLineQty(
      {
        quantity: 17.5,
        uom_snapshot_base_code: "KG",
      },
      { baseLabel: "ea" },
    );
    expect(f.primary).toBe("17.5 KG");
    expect(f.unitLabel).toBe("KG");
  });

  it("derives the display quantity from the frozen factor when absent", () => {
    const f = formatLineQty({
      quantity: 100,
      packaging_id: "pack-1",
      uom_snapshot_pack_name: "Bag",
      uom_snapshot_factor: 50,
      uom_snapshot_base_code: "KG",
    });
    expect(f.displayQuantity).toBe(2);
    expect(f.primary).toBe("2 Bag");
    expect(f.secondary).toBe("100 KG");
  });

  it("still handles plain base-unit lines", () => {
    expect(formatLineQtyString({ quantity: 3 }, { baseLabel: "ea" })).toBe("3 ea");
  });
});
