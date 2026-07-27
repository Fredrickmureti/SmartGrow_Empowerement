/**
 * Wave 7.2 · Step 3 — sales order snapshot builder unit test.
 *
 * Locks the projection (field names + coercions) that the shared
 * rendering engine reads for `document_kinds.code = 'sales.order_ack'`,
 * plus the determinism guarantee that keeps `ensure_document_record`
 * idempotent across retries and reprints.
 */
import { describe, it, expect } from "vitest";
import {
  buildSalesOrderSnapshot,
  type SalesOrderHeaderRow,
} from "@/services/documents/snapshots/salesOrder";

const ROW: SalesOrderHeaderRow = {
  id: "so-1",
  so_number: "SO-2026-0007",
  status: "confirmed",
  order_date: "2026-07-27",
  expected_date: "2026-08-05",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 50,
  shipping_amount: 20,
  total: 1130,
  currency: "KES",
  notes: "Ship as one consignment",
  shipping_address: "123 Warehouse Rd",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  contact: { name: "Acme Ltd", email: "ap@acme.test" },
  business: { id: "biz-1", name: "Widget Co" },
  items: [
    {
      description: "Widget A",
      quantity: 2,
      unit_price: 500,
      tax_rate: 16,
      tax_amount: 160,
      discount_percent: 5,
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
      discount_percent: null,
      line_total: 20,
      packaging: null,
      product: null,
    },
  ],
};

describe("buildSalesOrderSnapshot", () => {
  it("emits the sales_order document type + label the renderer keys off", () => {
    const { snapshot } = buildSalesOrderSnapshot(ROW);
    expect(snapshot.document_type).toBe("sales_order");
    expect(snapshot.document_type_label).toBe("SALES ORDER");
    expect(snapshot.document_number).toBe("SO-2026-0007");
  });

  it("returns routing metadata for ensureDocumentRecord", () => {
    const built = buildSalesOrderSnapshot(ROW);
    expect(built.documentNumber).toBe("SO-2026-0007");
    expect(built.documentDate).toBe("2026-07-27");
    expect(built.organizationId).toBe("org-1");
    expect(built.businessId).toBe("biz-1");
    expect(built.branchId).toBe("br-1");
    expect(built.currency).toBe("KES");
    expect(built.sourceDocId).toBe("so-1");
  });

  it("mirrors the fetchSalesOrder projection field-for-field", () => {
    const { snapshot } = buildSalesOrderSnapshot(ROW);
    expect(snapshot.status).toBe("confirmed");
    expect(snapshot.issue_date).toBe("2026-07-27");
    expect(snapshot.due_date).toBe("2026-08-05");
    expect(snapshot.subtotal).toBe(1000);
    expect(snapshot.tax_amount).toBe(160);
    expect(snapshot.discount_amount).toBe(50);
    expect(snapshot.shipping_amount).toBe(20);
    expect(snapshot.total).toBe(1130);
    expect(snapshot.amount_paid).toBe(0);
    expect(snapshot.currency).toBe("KES");
    expect(snapshot.shipping_address).toBe("123 Warehouse Rd");
    expect(snapshot.terms).toBeNull();
  });

  it("resolves unit_of_measure from packaging then base_uom then null", () => {
    const { snapshot } = buildSalesOrderSnapshot(ROW);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].unit_of_measure).toBe("BOX");
    expect(items[1].unit_of_measure).toBeNull();
  });

  it("coerces string numerics to numbers", () => {
    const cloned = {
      ...ROW,
      subtotal: "1000" as unknown as number,
      total: "1130" as unknown as number,
      items: [
        {
          ...ROW.items![0],
          quantity: "2" as unknown as number,
          unit_price: "500" as unknown as number,
          line_total: "1000" as unknown as number,
        },
      ],
    };
    const { snapshot } = buildSalesOrderSnapshot(cloned);
    expect(snapshot.subtotal).toBe(1000);
    expect(snapshot.total).toBe(1130);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items[0].quantity).toBe(2);
    expect(items[0].line_total).toBe(1000);
  });

  it("defaults currency to USD when missing", () => {
    const built = buildSalesOrderSnapshot({ ...ROW, currency: null });
    expect(built.currency).toBe("USD");
    expect((built.snapshot as Record<string, unknown>).currency).toBe("USD");
  });

  it("is deterministic: same input → byte-identical snapshot JSON", () => {
    const a = JSON.stringify(buildSalesOrderSnapshot(ROW).snapshot);
    const b = JSON.stringify(buildSalesOrderSnapshot(ROW).snapshot);
    expect(a).toBe(b);
  });

  it("throws when required identity fields are missing", () => {
    expect(() => buildSalesOrderSnapshot({ ...ROW, id: "" })).toThrow();
    expect(() => buildSalesOrderSnapshot({ ...ROW, so_number: "" })).toThrow();
    expect(() => buildSalesOrderSnapshot({ ...ROW, order_date: "" })).toThrow();
  });
});