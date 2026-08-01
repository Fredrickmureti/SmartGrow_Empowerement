/**
 * Phase C5 — packaging-level label identity (ADR-0102, extends ADR-0089).
 *
 * A case label must encode the CASE identifier. If the level has no
 * identifier the print is REFUSED — never a fallback to the each-level
 * barcode, the SKU, or an internal id.
 */
import { describe, it, expect } from "vitest";
import {
  resolveLabelBarcode,
  LABEL_LEVEL_BARCODE_REFUSAL,
} from "@/services/printing/labelBarcode";

const PRODUCT = { id: "uuid-1", sku: "COLA-500", barcode: "05012345678900", name: "Cola" };

describe("resolveLabelBarcode — level aware", () => {
  it("still resolves the each-level label from the product barcode", () => {
    expect(resolveLabelBarcode(PRODUCT)?.code).toBe("05012345678900");
  });

  it("encodes the level's own identifier for a level label", () => {
    const r = resolveLabelBarcode(PRODUCT, {
      packagingId: "pk1",
      name: "Case of 12",
      code: "15012345678907",
      qtyInBaseUom: 12,
    });
    expect(r?.code).toBe("15012345678907");
    expect(r?.skuDisplay).toBe("COLA-500");
  });

  it("refuses a level with no identifier instead of falling back", () => {
    expect(
      resolveLabelBarcode(PRODUCT, { packagingId: "pk1", name: "Case of 12", code: null }),
    ).toBeNull();
    expect(resolveLabelBarcode(PRODUCT, { name: "Pallet", code: "   " })).toBeNull();
  });

  it("never encodes an internal id, even with a level requested", () => {
    const r = resolveLabelBarcode({ id: "uuid-only" }, { name: "Case", code: null });
    expect(r).toBeNull();
    expect(LABEL_LEVEL_BARCODE_REFUSAL.description).toMatch(/Enrol a barcode for this level/);
  });
});
