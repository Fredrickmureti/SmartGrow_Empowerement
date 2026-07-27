/**
 * Wave 7.2 · Step 2 — sales proforma snapshot builder unit test.
 *
 * Locks the projection (field names + coercions) that the shared
 * rendering engine reads for `document_kinds.code = 'sales.proforma'`,
 * plus the determinism guarantee that keeps `ensure_document_record`
 * idempotent across retries and reprints.
 */
import { describe, it, expect } from "vitest";
import { buildSalesProformaSnapshot } from "@/services/documents/snapshots/salesProforma";
import type { SalesProformaHeaderRow } from "@/services/documents/snapshots/salesProforma";

const ROW: SalesProformaHeaderRow = {
  id: "pf-1",
  proforma_number: "PF-2026-0004",
  status: "sent",
  issue_date: "2026-07-27",
  expiry_date: "2026-08-10",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 50,
  total: 1110,
  currency: "KES",
  notes: "Not a tax invoice",
  terms: "Payable on acceptance",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  contact: { name: "Acme Ltd", email: "ap@acme.test" },
  business: { id: "biz-1", name: "Widget Co" },
  proforma_invoice_items: [
    {
      description: "Widget",
      quantity: 2,
      unit_price: 500,
      tax_rate: 16,
      tax_amount: 160,
      discount_percent: 5,
      line_total: 1000,
      packaging: { name: "BOX", qty_in_base_uom: 10 },
      product: { base_uom: { code: "EA", name: "Each" } },
    },
  ],
};

describe("buildSalesProformaSnapshot", () => {
  it("emits the proforma document type + label the renderer keys off", () => {
    const { snapshot } = buildSalesProformaSnapshot(ROW);
    expect(snapshot.document_type).toBe("proforma");
    expect(snapshot.document_type_label).toBe("PROFORMA INVOICE");
    expect(snapshot.document_number).toBe("PF-2026-0004");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildSalesProformaSnapshot(ROW);
    expect(built.documentNumber).toBe("PF-2026-0004");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("pf-1");
  });

  it("carries the proforma expiry date into the snapshot", () => {
    const { snapshot } = buildSalesProformaSnapshot(ROW);
    expect(snapshot.expiry_date).toBe("2026-08-10");
  });

  it("resolves unit_of_measure through packaging then base UOM", () => {
    const { snapshot } = buildSalesProformaSnapshot(ROW);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_of_measure).toBe("BOX");

    const noPack = buildSalesProformaSnapshot({
      ...ROW,
      proforma_invoice_items: [
        { ...ROW.proforma_invoice_items![0], packaging: null },
      ],
    });
    expect(
      (noPack.snapshot.items as Array<Record<string, unknown>>)[0].unit_of_measure,
    ).toBe("EA");
  });

  it("defaults currency and numeric fields instead of emitting null/NaN", () => {
    const { snapshot } = buildSalesProformaSnapshot({
      ...ROW,
      currency: null,
      discount_amount: null,
      proforma_invoice_items: [],
    });
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.discount_amount).toBe(0);
    expect(snapshot.items).toEqual([]);
  });

  it("is deterministic — repeat calls serialize identically", () => {
    const a = JSON.stringify(buildSalesProformaSnapshot(ROW).snapshot);
    const b = JSON.stringify(buildSalesProformaSnapshot(ROW).snapshot);
    expect(a).toBe(b);
  });

  it("refuses to build without the identity fields the record upsert needs", () => {
    expect(() => buildSalesProformaSnapshot({ ...ROW, id: "" })).toThrow(/proforma\.id/);
    expect(() => buildSalesProformaSnapshot({ ...ROW, proforma_number: "" })).toThrow(
      /proforma_number/,
    );
    expect(() => buildSalesProformaSnapshot({ ...ROW, issue_date: "" })).toThrow(
      /issue_date/,
    );
  });
});
