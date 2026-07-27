/**
 * Wave 7.1.5 — snapshot builder unit tests.
 *
 * Confirms `buildPosReceiptSnapshot` produces the JSON shape the renderer
 * requires. The keys checked here MUST stay in sync with the fixture used by
 * `supabase/functions/_shared/rendering/renderers/thermal_receipt_golden_test.ts`
 * — a mismatch means Wave 7.2's mechanical rewrite would drift bytes.
 */
import { describe, it, expect } from "vitest";
import type { POSReceiptSnapshot } from "@/hooks/pos/useReceiptSnapshot";
import { buildPosReceiptSnapshot } from "@/services/documents/snapshots/posReceipt";

const REQUIRED_KEYS = [
  "document_type",
  "document_type_label",
  "document_number",
  "issue_date",
  "status",
  "currency",
  "subtotal",
  "tax_amount",
  "discount_amount",
  "total",
  "amount_paid",
  "contact",
  "items",
  "pos_payments",
  "pos_receipt_settings",
  "cashier_name",
  "register_id",
];

const frozen: POSReceiptSnapshot = {
  schema_version: 1,
  transaction: {
    id: "txn-1",
    receipt_number: "R-2026-0001",
    transacted_at: "2026-07-20T10:15:00Z",
    status: "PAID",
    currency: "KES",
    subtotal_amount: 1000,
    tax_amount: 160,
    discount_amount: 50,
    total_amount: 1110,
    amount_paid: 1200,
    change_due: 90,
    notes: "Thanks",
  },
  items: [
    { description: "Espresso", quantity: 2, unit_price: 250, line_total: 500, tax_amount: 80, tax_rate: 16 },
  ],
  payments: [{ payment_method: "cash", amount: 1200, reference: null }],
  business: { id: "biz-1", name: "Café Niño" },
  branch: { id: "br-1", name: "HQ" },
  organization: { id: "org-1" },
  customer: { id: "cust-1", name: "Jane Doe", email: null, phone: null },
  cashier: { id: "u-1", name: "Alice", email: null },
  register: { id: "reg-1", code: "REG-01" },
  business_receipt_settings: { paper_size: "80mm" },
  register_receipt_settings: null,
};

describe("buildPosReceiptSnapshot", () => {
  it("emits every key the renderer reads", () => {
    const { snapshot } = buildPosReceiptSnapshot({ frozen });
    for (const k of REQUIRED_KEYS) {
      expect(snapshot, `missing renderer key: ${k}`).toHaveProperty(k);
    }
  });

  it("surfaces document_number / date / party for ensureDocumentRecord", () => {
    const r = buildPosReceiptSnapshot({ frozen });
    expect(r.documentNumber).toBe("R-2026-0001");
    expect(r.documentDate).toBe("2026-07-20");
    expect(r.currency).toBe("KES");
    expect(r.partyKind).toBe("customer");
    expect(r.partyId).toBe("cust-1");
    expect(r.businessId).toBe("biz-1");
    expect(r.branchId).toBe("br-1");
  });

  it("switches heading for merchant copy", () => {
    const customer = buildPosReceiptSnapshot({ frozen, copy: "customer" }).snapshot;
    const merchant = buildPosReceiptSnapshot({ frozen, copy: "merchant" }).snapshot;
    expect(customer.document_type_label).toBe("SALES RECEIPT");
    expect(merchant.document_type_label).toBe("MERCHANT COPY");
  });

  it("coerces missing numerics to 0 rather than NaN/undefined", () => {
    const stripped: POSReceiptSnapshot = {
      ...frozen,
      transaction: { id: "txn-2", receipt_number: null },
      items: [{ description: "X" }],
      payments: [{ payment_method: "cash" }],
    };
    const { snapshot } = buildPosReceiptSnapshot({ frozen: stripped });
    expect(snapshot.total).toBe(0);
    expect((snapshot.items as Array<Record<string, number>>)[0].quantity).toBe(0);
  });
});
