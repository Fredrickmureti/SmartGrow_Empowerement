/**
 * Wave 7.2 — sales invoice snapshot builder unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  buildSalesInvoiceSnapshot,
  type SalesInvoiceHeaderRow,
} from "@/services/documents/snapshots/salesInvoice";

function baseInvoice(overrides: Partial<SalesInvoiceHeaderRow> = {}): SalesInvoiceHeaderRow {
  return {
    id: "inv-1",
    invoice_number: "INV-2026-0001",
    status: "sent",
    issue_date: "2026-07-27",
    due_date: "2026-08-27",
    subtotal: 100,
    tax_amount: 16,
    discount_amount: 0,
    total: 116,
    amount_paid: 0,
    currency: "KES",
    notes: null,
    terms: null,
    organization_id: "org-1",
    business_id: "biz-1",
    branch_id: "br-1",
    contact: { name: "Acme Ltd", email: "ap@acme.test" },
    business: { id: "biz-1", name: "Widget Co" },
    invoice_items: [],
    ...overrides,
  };
}

describe("buildSalesInvoiceSnapshot", () => {
  it("emits the canonical DocumentData-shaped snapshot", () => {
    const out = buildSalesInvoiceSnapshot(baseInvoice());
    expect(out.snapshot).toMatchObject({
      document_type: "invoice",
      document_type_label: "INVOICE",
      document_number: "INV-2026-0001",
      currency: "KES",
      subtotal: 100,
      tax_amount: 16,
      total: 116,
    });
    expect(out.documentNumber).toBe("INV-2026-0001");
    expect(out.documentDate).toBe("2026-07-27");
    expect(out.sourceDocId).toBe("inv-1");
    expect(out.organizationId).toBe("org-1");
    expect(out.businessId).toBe("biz-1");
    expect(out.currency).toBe("KES");
  });

  it("defaults currency to USD when the invoice has none", () => {
    const out = buildSalesInvoiceSnapshot(baseInvoice({ currency: null }));
    expect(out.currency).toBe("USD");
    expect(out.snapshot.currency).toBe("USD");
  });

  it("normalises items and resolves unit_of_measure from packaging fallbacks", () => {
    const out = buildSalesInvoiceSnapshot(
      baseInvoice({
        invoice_items: [
          {
            description: "Widget",
            quantity: 2,
            unit_price: 50,
            tax_rate: 16,
            tax_amount: 16,
            discount_percent: null,
            line_total: 100,
            sku: "WID-1",
            packaging: { name: "Box of 12", qty_in_base_uom: 12 },
            product: { base_uom: { code: "EA", name: "each" } },
          },
        ],
      }),
    );
    const items = out.snapshot.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      description: "Widget",
      quantity: 2,
      unit_price: 50,
      line_total: 100,
      sku: "WID-1",
      unit_of_measure: "Box of 12",
    });
  });

  it("is deterministic on repeat calls with the same input", () => {
    const inv = baseInvoice({
      invoice_items: [
        {
          description: "A",
          quantity: 1,
          unit_price: 10,
          tax_rate: 0,
          tax_amount: 0,
          discount_percent: null,
          line_total: 10,
        },
      ],
    });
    const a = buildSalesInvoiceSnapshot(inv);
    const b = buildSalesInvoiceSnapshot(inv);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("rejects an invoice missing an id / number / issue_date", () => {
    expect(() => buildSalesInvoiceSnapshot(baseInvoice({ id: "" }))).toThrow(/invoice\.id/);
    expect(() =>
      buildSalesInvoiceSnapshot(baseInvoice({ invoice_number: "" })),
    ).toThrow(/invoice_number/);
    expect(() =>
      buildSalesInvoiceSnapshot(baseInvoice({ issue_date: "" })),
    ).toThrow(/issue_date/);
  });
});
