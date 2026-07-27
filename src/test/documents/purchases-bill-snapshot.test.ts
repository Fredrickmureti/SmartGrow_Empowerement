/**
 * Wave 7.2 — vendor bill snapshot builder unit test.
 *
 * Locks the projection (field names + coercions) that the shared
 * rendering engine reads for `document_kinds.code = 'purchases.bill'`,
 * plus the determinism guarantee that keeps `ensure_document_record`
 * idempotent across retries and reprints.
 */
import { describe, it, expect } from "vitest";
import {
  buildPurchasesBillSnapshot,
  type PurchasesBillHeaderRow,
} from "@/services/documents/snapshots/purchasesBill";

const ROW: PurchasesBillHeaderRow = {
  id: "bill-1",
  bill_number: "BILL-2026-0007",
  status: "received",
  bill_date: "2026-07-27",
  due_date: "2026-08-27",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 25,
  total: 1135,
  amount_paid: 200,
  currency: "KES",
  notes: "Net 30",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  vendor_id: "v-1",
  vendor: { name: "Widgets Supplier Ltd", email: "ar@widgets.test" },
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
      unit_price: 20,
      tax_rate: 0,
      tax_amount: 0,
      line_total: 20,
      packaging: null,
      product: null,
    },
  ],
};

describe("buildPurchasesBillSnapshot", () => {
  it("emits the bill document type + label the renderer keys off", () => {
    const { snapshot } = buildPurchasesBillSnapshot(ROW);
    expect(snapshot.document_type).toBe("bill");
    expect(snapshot.document_type_label).toBe("VENDOR BILL");
    expect(snapshot.document_number).toBe("BILL-2026-0007");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildPurchasesBillSnapshot(ROW);
    expect(built.documentNumber).toBe("BILL-2026-0007");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("bill-1");
    expect(built.vendorId).toBe("v-1");
  });

  it("mirrors the fetchBill projection field-for-field", () => {
    const { snapshot } = buildPurchasesBillSnapshot(ROW);
    expect(snapshot.status).toBe("received");
    expect(snapshot.issue_date).toBe("2026-07-27");
    expect(snapshot.due_date).toBe("2026-08-27");
    expect(snapshot.subtotal).toBe(1000);
    expect(snapshot.tax_amount).toBe(160);
    expect(snapshot.discount_amount).toBe(25);
    expect(snapshot.total).toBe(1135);
    expect(snapshot.amount_paid).toBe(200);
    expect(snapshot.currency).toBe("KES");
    expect(snapshot.notes).toBe("Net 30");
    expect(snapshot.terms).toBeNull();
    expect(snapshot.contact).toEqual(ROW.vendor);
  });

  it("resolves unit_of_measure from packaging then base_uom then null", () => {
    const { snapshot } = buildPurchasesBillSnapshot(ROW);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_of_measure).toBe("BOX");
    expect(items[1].unit_of_measure).toBeNull();
  });

  it("coerces string numerics to numbers and defaults nullable totals to 0", () => {
    const cloned: PurchasesBillHeaderRow = {
      ...ROW,
      subtotal: "1000" as unknown as number,
      total: "1135" as unknown as number,
      amount_paid: null,
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
    const { snapshot } = buildPurchasesBillSnapshot(cloned);
    expect(snapshot.subtotal).toBe(1000);
    expect(snapshot.total).toBe(1135);
    expect(snapshot.amount_paid).toBe(0);
    expect(snapshot.discount_amount).toBe(0);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].quantity).toBe(2);
    expect(items[0].tax_rate).toBe(0);
    expect(items[0].tax_amount).toBe(0);
  });

  it("defaults currency to USD when missing", () => {
    const built = buildPurchasesBillSnapshot({ ...ROW, currency: null });
    expect(built.currency).toBe("USD");
    expect(built.snapshot.currency).toBe("USD");
  });

  it("is deterministic across repeat calls (idempotent snapshot bytes)", () => {
    const a = buildPurchasesBillSnapshot(ROW);
    const b = buildPurchasesBillSnapshot(ROW);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("throws when required identity fields are missing", () => {
    expect(() =>
      buildPurchasesBillSnapshot({ ...ROW, id: "" as string }),
    ).toThrow(/bill\.id required/);
    expect(() =>
      buildPurchasesBillSnapshot({ ...ROW, bill_number: "" as string }),
    ).toThrow(/bill_number required/);
    expect(() =>
      buildPurchasesBillSnapshot({ ...ROW, bill_date: "" as string }),
    ).toThrow(/bill_date required/);
  });
});
