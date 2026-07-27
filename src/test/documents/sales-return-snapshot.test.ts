/**
 * Wave 7.2 · Step 4 — sales return snapshot builder unit test.
 */
import { describe, it, expect } from "vitest";
import {
  buildSalesReturnSnapshot,
  type SalesReturnHeaderRow,
} from "@/services/documents/snapshots/salesReturn";

const ROW: SalesReturnHeaderRow = {
  id: "sr-1",
  return_number: "SR-2026-0003",
  status: "approved",
  return_date: "2026-07-27",
  subtotal: 500,
  tax_amount: 80,
  total: 580,
  currency: "KES",
  reason: "Damaged on arrival",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  contact: { name: "Acme Ltd", email: "ap@acme.test" },
  business: { id: "biz-1", name: "Widget Co" },
  items: [
    {
      description: "Widget A",
      quantity: 1,
      unit_price: 500,
      tax_rate: 16,
      tax_amount: 80,
      line_total: 500,
      packaging: { name: "BOX", qty_in_base_uom: 10 },
      product: { base_uom: { code: "EA", name: "Each" } },
    },
    {
      description: "Widget B",
      quantity: 0,
      unit_price: 0,
      tax_rate: null,
      tax_amount: null,
      line_total: 0,
      packaging: null,
      product: null,
    },
  ],
};

describe("buildSalesReturnSnapshot", () => {
  it("emits the sales_return document type + label", () => {
    const { snapshot } = buildSalesReturnSnapshot(ROW);
    expect(snapshot.document_type).toBe("sales_return");
    expect(snapshot.document_type_label).toBe("SALES RETURN");
    expect(snapshot.document_number).toBe("SR-2026-0003");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildSalesReturnSnapshot(ROW);
    expect(built.documentNumber).toBe("SR-2026-0003");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("sr-1");
  });

  it("mirrors the fetchSalesReturn projection field-for-field", () => {
    const { snapshot } = buildSalesReturnSnapshot(ROW);
    expect(snapshot.status).toBe("approved");
    expect(snapshot.issue_date).toBe("2026-07-27");
    expect(snapshot.subtotal).toBe(500);
    expect(snapshot.tax_amount).toBe(80);
    expect(snapshot.discount_amount).toBe(0);
    expect(snapshot.total).toBe(580);
    expect(snapshot.currency).toBe("KES");
    expect(snapshot.notes).toBe("Damaged on arrival");
    expect(snapshot.terms).toBeNull();
  });

  it("resolves unit_of_measure from packaging then base_uom then null", () => {
    const { snapshot } = buildSalesReturnSnapshot(ROW);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_of_measure).toBe("BOX");
    expect(items[1].unit_of_measure).toBeNull();
  });

  it("defaults currency to USD when missing", () => {
    const built = buildSalesReturnSnapshot({ ...ROW, currency: null });
    expect(built.currency).toBe("USD");
  });

  it("is deterministic: same input → byte-identical snapshot JSON", () => {
    const a = JSON.stringify(buildSalesReturnSnapshot(ROW).snapshot);
    const b = JSON.stringify(buildSalesReturnSnapshot(ROW).snapshot);
    expect(a).toBe(b);
  });

  it("throws when required identity fields are missing", () => {
    expect(() => buildSalesReturnSnapshot({ ...ROW, id: "" })).toThrow();
    expect(() => buildSalesReturnSnapshot({ ...ROW, return_number: "" })).toThrow();
    expect(() => buildSalesReturnSnapshot({ ...ROW, return_date: "" })).toThrow();
  });
});