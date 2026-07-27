/**
 * Wave 7.2 — sales credit-note snapshot builder unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  buildSalesCreditNoteSnapshot,
  type SalesCreditNoteHeaderRow,
} from "@/services/documents/snapshots/salesCreditNote";

function baseCN(
  overrides: Partial<SalesCreditNoteHeaderRow> = {},
): SalesCreditNoteHeaderRow {
  return {
    id: "cn-1",
    credit_note_number: "CN-2026-0001",
    status: "issued",
    issue_date: "2026-07-27",
    subtotal: 100,
    tax_amount: 16,
    total: 116,
    currency: "KES",
    notes: null,
    reason: "Returned goods",
    organization_id: "org-1",
    business_id: "biz-1",
    branch_id: "br-1",
    contact_id: "c-1",
    contact: { name: "Acme Ltd", email: "ap@acme.test" },
    business: { id: "biz-1", name: "Widget Co" },
    credit_note_items: [],
    ...overrides,
  };
}

describe("buildSalesCreditNoteSnapshot", () => {
  it("emits the canonical DocumentData-shaped snapshot", () => {
    const out = buildSalesCreditNoteSnapshot(baseCN());
    expect(out.snapshot).toMatchObject({
      document_type: "credit_note",
      document_type_label: "CREDIT NOTE",
      document_number: "CN-2026-0001",
      currency: "KES",
      subtotal: 100,
      tax_amount: 16,
      total: 116,
      reason: "Returned goods",
    });
    expect(out.documentNumber).toBe("CN-2026-0001");
    expect(out.documentDate).toBe("2026-07-27");
    expect(out.sourceDocId).toBe("cn-1");
    expect(out.organizationId).toBe("org-1");
    expect(out.businessId).toBe("biz-1");
    expect(out.contactId).toBe("c-1");
  });

  it("defaults currency to USD when the credit note has none", () => {
    const out = buildSalesCreditNoteSnapshot(baseCN({ currency: null }));
    expect(out.currency).toBe("USD");
    expect(out.snapshot.currency).toBe("USD");
  });

  it("normalises items and resolves unit_of_measure from packaging fallbacks", () => {
    const out = buildSalesCreditNoteSnapshot(
      baseCN({
        credit_note_items: [
          {
            description: "Widget",
            quantity: 2,
            unit_price: 50,
            tax_rate: 16,
            tax_amount: 16,
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
    const cn = baseCN({
      credit_note_items: [
        {
          description: "A",
          quantity: 1,
          unit_price: 10,
          tax_rate: 0,
          tax_amount: 0,
          line_total: 10,
        },
      ],
    });
    const a = buildSalesCreditNoteSnapshot(cn);
    const b = buildSalesCreditNoteSnapshot(cn);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("rejects a row missing id / number / issue_date", () => {
    expect(() => buildSalesCreditNoteSnapshot(baseCN({ id: "" }))).toThrow(/cn\.id/);
    expect(() =>
      buildSalesCreditNoteSnapshot(baseCN({ credit_note_number: "" })),
    ).toThrow(/credit_note_number/);
    expect(() =>
      buildSalesCreditNoteSnapshot(baseCN({ issue_date: "" })),
    ).toThrow(/issue_date/);
  });
});
