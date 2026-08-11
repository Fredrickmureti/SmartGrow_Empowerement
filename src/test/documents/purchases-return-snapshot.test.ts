import { describe, it, expect } from "vitest";
import {
  buildPurchasesReturnSnapshot,
  type PurchasesReturnHeaderRow,
} from "@/services/documents/snapshots/purchasesReturn";

const ROW: PurchasesReturnHeaderRow = {
  id: "pr-1",
  return_number: "PR-2026-0002",
  status: "approved",
  return_date: "2026-07-27",
  subtotal: 500,
  tax_amount: 80,
  total: 580,
  currency: "KES",
  notes: null,
  reason: "damaged",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  vendor_id: "v-1",
  contact: { name: "Widgets Supplier Ltd" },
  business: { id: "biz-1", name: "Acme Buyer", base_currency: "KES" },
  items: [
    {
      description: null,
      quantity: 1,
      unit_price: 500,
      tax_rate: 16,
      tax_amount: 80,
      line_total: 500,
      return_reason: "cracked",
      condition: "damaged",
      packaging: { name: "BOX", qty_in_base_uom: 10 },
      product: { name: "Widget A", sku: "W-A", base_uom: { code: "EA", name: "Each" } },
    },
  ],
};

describe("buildPurchasesReturnSnapshot", () => {
  it("emits the vendor_return document type + label", () => {
    const { snapshot } = buildPurchasesReturnSnapshot(ROW);
    expect(snapshot.document_type).toBe("vendor_return");
    expect(snapshot.document_type_label).toBe("VENDOR RETURN");
    expect(snapshot.document_number).toBe("PR-2026-0002");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildPurchasesReturnSnapshot(ROW);
    expect(built.documentNumber).toBe("PR-2026-0002");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("pr-1");
    expect(built.vendorId).toBe("v-1");
  });

  it("falls back notes → reason and description → product.name", () => {
    const { snapshot } = buildPurchasesReturnSnapshot(ROW);
    expect(snapshot.notes).toBe("damaged");
    const items = snapshot.items as Array<Record<string, unknown>>;
    // Phase 10: the line description carries its traceability decoration
    // (lot / serial / condition / reason) so the supplier copy is
    // self-explanatory. The product-name fallback is still the base.
    expect(items[0].description).toBe("Widget A (damaged · cracked)");
    expect(items[0].sku).toBe("W-A");
    expect(items[0].unit_of_measure).toBe("BOX");
  });

  it("defaults currency to business.base_currency then USD", () => {
    const noCur = buildPurchasesReturnSnapshot({ ...ROW, currency: null });
    expect(noCur.currency).toBe("KES");
    const noneEither = buildPurchasesReturnSnapshot({
      ...ROW,
      currency: null,
      business: { id: "b", name: "n" },
    });
    expect(noneEither.currency).toBe("USD");
  });

  it("coerces string numerics and defaults nullable totals to 0", () => {
    const cloned: PurchasesReturnHeaderRow = {
      ...ROW,
      subtotal: "500" as unknown as number,
      total: "580" as unknown as number,
      tax_amount: null,
    };
    const { snapshot } = buildPurchasesReturnSnapshot(cloned);
    expect(snapshot.subtotal).toBe(500);
    expect(snapshot.total).toBe(580);
    expect(snapshot.tax_amount).toBe(0);
  });

  it("is deterministic", () => {
    const a = buildPurchasesReturnSnapshot(ROW);
    const b = buildPurchasesReturnSnapshot(ROW);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("throws on missing identity fields", () => {
    expect(() => buildPurchasesReturnSnapshot({ ...ROW, id: "" })).toThrow(/pr\.id required/);
    expect(() => buildPurchasesReturnSnapshot({ ...ROW, return_number: "" })).toThrow(/return_number required/);
    expect(() => buildPurchasesReturnSnapshot({ ...ROW, return_date: "" })).toThrow(/return_date required/);
  });
});
