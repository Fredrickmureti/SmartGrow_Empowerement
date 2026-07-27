import { describe, it, expect } from "vitest";
import {
  buildPurchasesPoSnapshot,
  type PurchasesPoHeaderRow,
} from "@/services/documents/snapshots/purchasesPo";

const ROW: PurchasesPoHeaderRow = {
  id: "po-1",
  po_number: "PO-2026-0009",
  status: "sent",
  order_date: "2026-07-27",
  expected_date: "2026-08-05",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 0,
  total: 1160,
  currency: "KES",
  notes: "Deliver to dock 3",
  shipping_address: "12 Warehouse Rd",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  vendor_id: "v-1",
  vendor: { name: "Widgets Supplier Ltd", email: "orders@widgets.test" },
  business: { id: "biz-1", name: "Acme Buyer" },
  items: [
    {
      description: "Widget A",
      quantity: 2,
      unit_price: 500,
      tax_rate: 16,
      tax_amount: 160,
      line_total: 1000,
      packaging: { name: "BOX", qty_in_base_uom: 10 },
      product: { base_uom: { code: "EA", name: "Each" } },
    },
    {
      description: "Widget B",
      quantity: 1,
      unit_price: 0,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 0,
      packaging: null,
      product: null,
    },
  ],
};

describe("buildPurchasesPoSnapshot", () => {
  it("emits the purchase_order document type + label", () => {
    const { snapshot } = buildPurchasesPoSnapshot(ROW);
    expect(snapshot.document_type).toBe("purchase_order");
    expect(snapshot.document_type_label).toBe("PURCHASE ORDER");
    expect(snapshot.document_number).toBe("PO-2026-0009");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildPurchasesPoSnapshot(ROW);
    expect(built.documentNumber).toBe("PO-2026-0009");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("po-1");
    expect(built.vendorId).toBe("v-1");
  });

  it("mirrors the fetchPurchaseOrder projection field-for-field", () => {
    const { snapshot } = buildPurchasesPoSnapshot(ROW);
    expect(snapshot.status).toBe("sent");
    expect(snapshot.issue_date).toBe("2026-07-27");
    expect(snapshot.due_date).toBe("2026-08-05");
    expect(snapshot.subtotal).toBe(1000);
    expect(snapshot.tax_amount).toBe(160);
    expect(snapshot.discount_amount).toBe(0);
    expect(snapshot.total).toBe(1160);
    expect(snapshot.currency).toBe("KES");
    expect(snapshot.notes).toBe("Deliver to dock 3");
    expect(snapshot.terms).toBeNull();
    expect(snapshot.contact).toEqual(ROW.vendor);
    expect(snapshot.shipping_address).toBe("12 Warehouse Rd");
  });

  it("resolves unit_of_measure from packaging then base_uom then null", () => {
    const { snapshot } = buildPurchasesPoSnapshot(ROW);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_of_measure).toBe("BOX");
    expect(items[1].unit_of_measure).toBeNull();
  });

  it("coerces string numerics and defaults nullable totals to 0", () => {
    const cloned: PurchasesPoHeaderRow = {
      ...ROW,
      subtotal: "1000" as unknown as number,
      total: "1160" as unknown as number,
      discount_amount: null,
      items: [
        {
          ...ROW.items![0],
          quantity: "2" as unknown as number,
          unit_price: "500" as unknown as number,
          line_total: "1000" as unknown as number,
          tax_rate: null,
          tax_amount: null,
        },
      ],
    };
    const { snapshot } = buildPurchasesPoSnapshot(cloned);
    expect(snapshot.subtotal).toBe(1000);
    expect(snapshot.total).toBe(1160);
    expect(snapshot.discount_amount).toBe(0);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].quantity).toBe(2);
    expect(items[0].tax_rate).toBe(0);
    expect(items[0].tax_amount).toBe(0);
  });

  it("defaults currency to USD when missing", () => {
    const built = buildPurchasesPoSnapshot({ ...ROW, currency: null });
    expect(built.currency).toBe("USD");
    expect(built.snapshot.currency).toBe("USD");
  });

  it("is deterministic across repeat calls", () => {
    const a = buildPurchasesPoSnapshot(ROW);
    const b = buildPurchasesPoSnapshot(ROW);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("throws when required identity fields are missing", () => {
    expect(() => buildPurchasesPoSnapshot({ ...ROW, id: "" })).toThrow(/po\.id required/);
    expect(() => buildPurchasesPoSnapshot({ ...ROW, po_number: "" })).toThrow(/po_number required/);
    expect(() => buildPurchasesPoSnapshot({ ...ROW, order_date: "" })).toThrow(/order_date required/);
  });
});
