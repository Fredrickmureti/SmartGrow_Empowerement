/**
 * Multi-Unit Inventory — presentation contract.
 *
 * These tests are the single source of truth for "what does Qty look
 * like on a receipt / invoice / PO when the cashier sold 1 Box of 10".
 * Renderers (PreviewRenderer, LineItemsTable, assembleItems) all delegate
 * to these helpers; if a renderer regresses we want this test to fail.
 */
import { describe, it, expect } from "vitest";
import { formatLineQty, formatLineQtyString, toBase, fromBase, baseUomLabel } from "@/lib/inventory/uom";
import { formatTransactionQty } from "@/lib/inventory/formatQty";

describe("uom.toBase / fromBase round-trip", () => {
  it("respects the packaging factor", () => {
    const pack = { name: "Box", qty_in_base_uom: 10 };
    expect(toBase(1, pack)).toBe(10);
    expect(toBase(2.5, pack)).toBe(25);
    expect(fromBase(50, pack)).toBe(5);
  });

  it("passes through the value when packaging is missing or invalid", () => {
    expect(toBase(7, null)).toBe(7);
    expect(toBase(7, { name: "Bad", qty_in_base_uom: 0 })).toBe(7);
    expect(fromBase(7, undefined)).toBe(7);
  });
});

describe("baseUomLabel fallback", () => {
  it("prefers code, then name, then 'ea'", () => {
    expect(baseUomLabel({ code: "tab" })).toBe("tab");
    expect(baseUomLabel({ name: "Tablet" })).toBe("Tablet");
    expect(baseUomLabel(null)).toBe("ea");
  });
});

describe("formatLineQty — pack provenance present", () => {
  it("renders display + pack with base breakdown by default", () => {
    const f = formatLineQty(
      { packaging_id: "p1", quantity: 10, display_quantity: 1, packaging: { name: "Box", qty_in_base_uom: 10 } },
      { baseLabel: "tab" },
    );
    expect(f.primary).toBe("1 Box");
    expect(f.secondary).toBe("10 tab");
    expect(formatLineQtyString(
      { packaging_id: "p1", quantity: 10, display_quantity: 1, packaging: { name: "Box", qty_in_base_uom: 10 } },
      { baseLabel: "tab" },
    )).toBe("1 Box (10 tab)");
  });

  it("suppresses base breakdown when factor is 1 (Strip-of-1 pack)", () => {
    const f = formatLineQty(
      { packaging_id: "p1", quantity: 3, display_quantity: 3, packaging: { name: "Strip", qty_in_base_uom: 1 } },
      { baseLabel: "ea" },
    );
    expect(f.secondary).toBeNull();
  });

  it("can suppress the base breakdown for compact thermal receipts", () => {
    const f = formatLineQty(
      { packaging_id: "p1", quantity: 100, display_quantity: 1, packaging: { name: "Carton", qty_in_base_uom: 100 } },
      { baseLabel: "ea", showBaseBreakdown: false },
    );
    expect(f.secondary).toBeNull();
    expect(f.primary).toBe("1 Carton");
  });
});

describe("formatLineQty — no pack provenance", () => {
  it("falls back to base units only", () => {
    const f = formatLineQty({ quantity: 10 }, { baseLabel: "ea" });
    expect(f.primary).toBe("10 ea");
    expect(f.secondary).toBeNull();
  });
});

describe("formatTransactionQty (renderer-shared formatter)", () => {
  it("matches the canonical 1-Box-of-10 case used by receipts and invoices", () => {
    expect(formatTransactionQty(1, "Box", 10, "ea")).toBe("1 Box (10 ea)");
    expect(formatTransactionQty(1, "Box", 10, "ea", { showBase: false })).toBe("1 Box");
    expect(formatTransactionQty(10, null, 10, "ea")).toBe("10 ea");
  });
});
