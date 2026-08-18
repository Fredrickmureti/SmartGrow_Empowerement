/**
 * Architecture ratchet — stock adjustment UoM + lot contract.
 *
 * The adjustment form sends INTENT (pack + count, lot number); the database
 * converts to base units via `_uom_normalize_adj_line`. If a future edit
 * reintroduces client-side conversion, or drops the lot/pack fields from the
 * payload, this test fails.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const FORM = read("src/pages/inventory/AdjustmentNew.tsx");
const HOOK = read("src/hooks/useInventory.ts");

describe("stock adjustment — UoM and lot contract", () => {
  it("sends pack intent, not a converted base quantity", () => {
    expect(FORM).toContain("display_quantity: i.packaging_id");
    expect(FORM).toContain("packaging_id: i.packaging_id");
    // No client-side multiplication of the entered quantity by a pack factor
    // in the submitted payload.
    const payload = FORM.slice(
      FORM.indexOf("items: filtered.map("),
      FORM.indexOf("navigate(\"/inventory-app/stock\")"),
    );
    expect(payload).not.toMatch(/quantity_adjustment:[^,]*pack_factor/);
    expect(payload).not.toMatch(/display_quantity:[^,]*\*/);
  });

  it("captures lot identity for positive lot-tracked lines", () => {
    expect(FORM).toContain("is_lot_tracked");
    expect(FORM).toContain("lot_number: i.lot_number.trim() || null");
    expect(FORM).toContain("expiry_date: i.expiry_date || null");
  });

  it("forwards provenance fields through the hook without arithmetic", () => {
    for (const field of [
      "packaging_id",
      "display_uom_id",
      "display_quantity",
      "lot_number",
      "serial_number",
      "expiry_date",
    ]) {
      expect(HOOK).toContain(`${field}: i.${field} ?? null`);
    }
  });
});
