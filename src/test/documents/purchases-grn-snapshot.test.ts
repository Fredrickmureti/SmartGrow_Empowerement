/**
 * Wave 7.2 — Goods Received Note snapshot builder tests.
 *
 * The business rule under test is the one a warehouse manager cares about:
 * a GRN records QUANTITIES, never money. Any regression that lets PO
 * pricing bleed onto a receiving document is caught here.
 */
import { describe, it, expect } from "vitest";
import {
  buildPurchasesGrnSnapshot,
  type PurchasesGrnHeaderRow,
} from "@/services/documents/snapshots/purchasesGrn";

const base: PurchasesGrnHeaderRow = {
  id: "grn-1",
  receipt_number: "GRN-0001",
  status: "received",
  receipt_date: "2026-07-27T08:30:00Z",
  notes: "Two cartons dented, accepted.",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "branch-1",
  purchase_order_id: "po-1",
  purchase_order: {
    po_number: "PO-0007",
    currency: "KES",
    vendor_id: "vendor-1",
    vendor: { name: "Acme Supplies", email: "ap@acme.test" },
  },
  items: [
    {
      description: "Widget A",
      quantity_received: 12,
      display_quantity: 1,
      uom_snapshot: null,
      packaging: { name: "Carton", qty_in_base_uom: 12 },
      product: { base_uom: { code: "ea", name: "Each" } },
    },
  ],
};

describe("buildPurchasesGrnSnapshot", () => {
  it("emits the goods_received_note type and label", () => {
    const { snapshot } = buildPurchasesGrnSnapshot(base);
    expect(snapshot.document_type).toBe("goods_received_note");
    expect(snapshot.document_type_label).toBe("GOODS RECEIVED NOTE");
  });

  it("is quantity-only: every monetary field is zero", () => {
    const { snapshot } = buildPurchasesGrnSnapshot(base);
    expect(snapshot.subtotal).toBe(0);
    expect(snapshot.tax_amount).toBe(0);
    expect(snapshot.discount_amount).toBe(0);
    expect(snapshot.total).toBe(0);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_price).toBe(0);
    expect(items[0].line_total).toBe(0);
    expect(items[0].tax_amount).toBe(0);
    expect(items[0].quantity).toBe(12);
  });

  it("carries routing metadata and the source PO as reference", () => {
    const built = buildPurchasesGrnSnapshot(base);
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("branch-1");
    expect(built.vendorId).toBe("vendor-1");
    expect(built.currency).toBe("KES");
    expect(built.documentNumber).toBe("GRN-0001");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.snapshot.reference).toBe("PO-0007");
  });

  it("derives a uom_snapshot from packaging when none is stored", () => {
    const items = buildPurchasesGrnSnapshot(base).snapshot.items as Array<
      Record<string, unknown>
    >;
    expect(items[0].uom_snapshot).toBe("Carton × 12 ea");
    expect(items[0].base_uom_label).toBe("ea");
    expect(items[0].packaging_label).toBe("Carton");
  });

  it("prefers a stored uom_snapshot over the derived one", () => {
    const items = buildPurchasesGrnSnapshot({
      ...base,
      items: [{ ...base.items![0], uom_snapshot: "Pallet × 480 ea" }],
    }).snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].uom_snapshot).toBe("Pallet × 480 ea");
  });

  it("falls back to USD when the PO carries no currency", () => {
    const built = buildPurchasesGrnSnapshot({
      ...base,
      purchase_order: { ...base.purchase_order!, currency: null },
    });
    expect(built.currency).toBe("USD");
  });

  it("tolerates a direct receipt with no purchase order", () => {
    const built = buildPurchasesGrnSnapshot({
      ...base,
      purchase_order: null,
      items: [],
    });
    expect(built.vendorId).toBeNull();
    expect(built.snapshot.contact).toBeNull();
    expect(built.snapshot.reference).toBeNull();
    expect(built.snapshot.items).toEqual([]);
  });

  it("is deterministic", () => {
    expect(buildPurchasesGrnSnapshot(base)).toEqual(buildPurchasesGrnSnapshot(base));
  });

  it("guards required identity fields", () => {
    expect(() => buildPurchasesGrnSnapshot({ ...base, id: "" })).toThrow(/id required/);
    expect(() => buildPurchasesGrnSnapshot({ ...base, receipt_number: "" })).toThrow(
      /receipt_number required/,
    );
    expect(() => buildPurchasesGrnSnapshot({ ...base, receipt_date: "" })).toThrow(
      /receipt_date required/,
    );
  });
});
