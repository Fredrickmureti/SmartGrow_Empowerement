/**
 * Wave 7.2 · Step 1 — sales estimate snapshot builder unit test.
 *
 * Locks the projection (field names + coercions) that the shared
 * rendering engine reads for `document_kinds.code = 'sales.estimate'`,
 * plus the determinism guarantee that keeps `ensure_document_record`
 * idempotent across retries and reprints.
 */
import { describe, it, expect } from "vitest";
import { buildSalesEstimateSnapshot } from "@/services/documents/snapshots/salesEstimate";
import type { SalesEstimateHeaderRow } from "@/services/documents/snapshots/salesEstimate";

const ROW: SalesEstimateHeaderRow = {
  id: "est-1",
  estimate_number: "EST-2026-0007",
  status: "sent",
  issue_date: "2026-07-27",
  expiry_date: "2026-08-10",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 50,
  total: 1110,
  currency: "KES",
  notes: "Valid for 14 days",
  terms: "50% deposit",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  contact: { name: "Acme Ltd", email: "ap@acme.test" },
  business: { id: "biz-1", name: "Widget Co" },
  estimate_items: [
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

describe("buildSalesEstimateSnapshot", () => {
  it("emits the estimate document type + label the renderer keys off", () => {
    const { snapshot } = buildSalesEstimateSnapshot(ROW);
    expect(snapshot.document_type).toBe("estimate");
    expect(snapshot.document_type_label).toBe("QUOTATION");
    expect(snapshot.document_number).toBe("EST-2026-0007");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildSalesEstimateSnapshot(ROW);
    expect(built.documentNumber).toBe("EST-2026-0007");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("est-1");
  });

  it("carries estimate-specific fields (expiry + signature) into the snapshot", () => {
    const { snapshot } = buildSalesEstimateSnapshot({
      ...ROW,
      customer_signature_url: "https://x/sig.png",
      signed_at: "2026-07-28T09:00:00Z",
    });
    expect(snapshot.expiry_date).toBe("2026-08-10");
    expect(snapshot.customer_signature_url).toBe("https://x/sig.png");
    expect(snapshot.signed_at).toBe("2026-07-28T09:00:00Z");
  });

  it("resolves unit_of_measure through packaging then base UOM", () => {
    const { snapshot } = buildSalesEstimateSnapshot(ROW);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_of_measure).toBe("BOX");

    const noPack = buildSalesEstimateSnapshot({
      ...ROW,
      estimate_items: [{ ...ROW.estimate_items![0], packaging: null }],
    });
    expect(
      (noPack.snapshot.items as Array<Record<string, unknown>>)[0].unit_of_measure,
    ).toBe("EA");
  });

  it("defaults currency and numeric fields instead of emitting null/NaN", () => {
    const { snapshot } = buildSalesEstimateSnapshot({
      ...ROW,
      currency: null,
      discount_amount: null,
      estimate_items: [],
    });
    expect(snapshot.currency).toBe("USD");
    expect(snapshot.discount_amount).toBe(0);
    expect(snapshot.items).toEqual([]);
  });

  it("is deterministic — repeat calls serialize identically", () => {
    const a = JSON.stringify(buildSalesEstimateSnapshot(ROW).snapshot);
    const b = JSON.stringify(buildSalesEstimateSnapshot(ROW).snapshot);
    expect(a).toBe(b);
  });

  it("refuses to build without the identity fields the record upsert needs", () => {
    expect(() => buildSalesEstimateSnapshot({ ...ROW, id: "" })).toThrow(/estimate\.id/);
    expect(() => buildSalesEstimateSnapshot({ ...ROW, estimate_number: "" })).toThrow(
      /estimate_number/,
    );
    expect(() => buildSalesEstimateSnapshot({ ...ROW, issue_date: "" })).toThrow(
      /issue_date/,
    );
  });
});
