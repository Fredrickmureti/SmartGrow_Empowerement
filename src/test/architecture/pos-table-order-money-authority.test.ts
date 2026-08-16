/**
 * Architecture guard — POS Wave Phase 5.
 *
 * Restaurant table orders must not price themselves in the browser. Every
 * line/total mutation goes through `pos_sync_table_order`, which prices the
 * cart with `pos_quote_cart` / `pos_resolve_line` server-side. This test
 * fails the build if a future edit re-introduces client-side money math or
 * direct writes to the money columns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../hooks/pos/useTableOrder.ts");
const code = readFileSync(SRC, "utf8");

describe("table order money authority", () => {
  it("routes mutations through the pos_sync_table_order RPC", () => {
    expect(code).toContain("pos_sync_table_order");
  });

  it("never writes pos_transaction_items from the client", () => {
    expect(code).not.toMatch(/from\(\s*["']pos_transaction_items["']\s*\)\s*\.\s*(insert|update|delete)/s);
  });

  it("never writes money columns on pos_transactions from the client", () => {
    const updates = code.match(/from\(\s*["']pos_transactions["']\s*\)[\s\S]{0,600}?\.update\(([\s\S]{0,600}?)\)\s*\n/g) ?? [];
    for (const block of updates) {
      for (const col of ["subtotal", "tax_amount", "total", "discount_amount", "version"]) {
        expect(block, `client update must not set ${col}`).not.toMatch(new RegExp(`\\b${col}\\s*:`));
      }
    }
  });

  it("does not recompute line or cart money in JS", () => {
    expect(code).not.toContain("calculateItemTotals");
    expect(code).not.toMatch(/tax_rate\s*\/\s*100/);
    expect(code).not.toMatch(/quantity\s*\*\s*item\.unit_price/);
  });

  it("reads totals back from the server-written transaction row", () => {
    expect(code).toMatch(/subtotal:\s*Number\(txnRow\?\.subtotal/);
    expect(code).toMatch(/total:\s*Number\(txnRow\?\.total/);
  });

  it("honours optimistic concurrency instead of last-write-wins", () => {
    expect(code).toContain("p_expected_version");
    expect(code).toMatch(/conflict|another terminal/i);
  });
});
