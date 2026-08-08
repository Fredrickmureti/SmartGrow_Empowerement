/**
 * Opening-stock → GL trigger guards.
 *
 * Root-cause audit (docs/audit/2026-05-28-opening-stock-gl-trigger-rca.md)
 * confirmed the "30,000 inventory asset" entry is correct: it is the
 * cost-based capitalization of opening stock, triggered by an
 * opening-balance inventory transaction — NOT by mere product creation.
 *
 * These tests pin the two invariants that keep that boundary intact at the
 * product-create call site:
 *   1. The create flow only routes to the opening-stock atomic RPC when a
 *      positive opening quantity is supplied (config vs transaction split).
 *   2. Opening stock is valued at COST (unit_cost / cost_price), never at
 *      the selling price (unit_price).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const PRODUCTS = readFileSync("src/pages/inventory/ProductForm.tsx", "utf8");

describe("opening-stock GL trigger boundary (Products create flow)", () => {
  it("only posts opening stock when a positive quantity is supplied", () => {
    // Opening items are filtered to positive quantities before the atomic RPC.
    expect(PRODUCTS).toMatch(/\.filter\(\s*\(\[\s*,\s*qty\s*\]\)\s*=>\s*Number\(qty\)\s*>\s*0\s*\)/);
    // The atomic RPC is gated behind a non-empty opening-items list.
    expect(PRODUCTS).toContain("openingItems.length > 0");
    expect(PRODUCTS).toContain("create_product_with_opening_stock_atomic");
  });

  it("values opening stock at cost (unit_cost / cost_price), never selling price", () => {
    // The opening line cost falls back to cost_price, not unit_price.
    expect(PRODUCTS).toContain("Number(formData.cost_price)");
    // Guard: the opening-items mapper must not source unit cost from unit_price.
    const mapperStart = PRODUCTS.indexOf("const openingItems = Object.entries(openingByWarehouse)");
    const mapperEnd = PRODUCTS.indexOf("const useAtomic", mapperStart) > -1 ? PRODUCTS.indexOf("const useAtomic", mapperStart) : mapperStart + 800;
    const mapper = PRODUCTS.slice(mapperStart, mapperEnd);
    expect(mapper).not.toMatch(/unit_price/);
  });

  it("surfaces the resulting journal entry to the operator (traceability)", () => {
    expect(PRODUCTS).toContain("/finance/journal-entries?selected=");
    expect(PRODUCTS).toContain("Posted to general ledger");
  });
});
