/**
 * Wave 7.2 · Step 5 — customer payment receipt snapshot builder unit test.
 *
 * Locks the items-as-truth allocation contract described in
 * `fetchReceipt` (generate-document): allocations map 1:1 to items,
 * currency is uniform-or-fallback, unapplied is emitted only when the
 * whole payment is being rendered, and totals derive from items only.
 */
import { describe, it, expect } from "vitest";
import {
  buildPaymentReceiptSnapshot,
  type PaymentAllocationRow,
  type PaymentHeaderRow,
} from "@/services/documents/snapshots/salesPaymentReceipt";

const PAYMENT: PaymentHeaderRow = {
  id: "pay-1",
  receipt_number: "RCP-2026-0001",
  payment_date: "2026-07-27",
  amount: 1500,
  status: "completed",
  currency: "KES",
  notes: "Cheque #4471",
  payment_method: "bank_transfer",
  reference: "TXN-9911",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: "br-1",
  contact: { name: "Acme Ltd", email: "ap@acme.test" },
  business: { id: "biz-1", name: "Widget Co", base_currency: "KES" },
};

const ALLOCS: PaymentAllocationRow[] = [
  {
    invoice_id: "inv-b",
    amount: 600,
    invoices: {
      id: "inv-b",
      invoice_number: "INV-002",
      issue_date: "2026-07-20",
      total: 800,
      amount_paid: 800,
      currency: "KES",
    },
  },
  {
    invoice_id: "inv-a",
    amount: 400,
    invoices: {
      id: "inv-a",
      invoice_number: "INV-001",
      issue_date: "2026-07-10",
      total: 400,
      amount_paid: 400,
      currency: "KES",
    },
  },
];

describe("buildPaymentReceiptSnapshot", () => {
  it("emits document_type 'receipt' with a stable label + number", () => {
    const { snapshot, documentNumber } = buildPaymentReceiptSnapshot(PAYMENT, ALLOCS);
    expect(snapshot.document_type).toBe("receipt");
    expect(snapshot.document_type_label).toBe("PAYMENT RECEIPT");
    expect(documentNumber).toBe("RCP-2026-0001");
    expect(snapshot.document_number).toBe("RCP-2026-0001");
  });

  it("falls back to RCP-<uuid8> when receipt_number is missing", () => {
    const { documentNumber } = buildPaymentReceiptSnapshot(
      { ...PAYMENT, receipt_number: null, id: "aaaaaaaa-1111-2222-3333-444444444444" },
      ALLOCS,
    );
    expect(documentNumber).toBe("RCP-aaaaaaaa");
  });

  it("sorts allocations by issue_date then invoice_number", () => {
    const { snapshot } = buildPaymentReceiptSnapshot(PAYMENT, ALLOCS);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3); // 2 alloc + unapplied (1500 - 1000)
    expect(items[0].description).toContain("INV-001");
    expect(items[1].description).toContain("INV-002");
    expect(items[2].description).toBe("Unapplied advance (on account)");
    expect(items[2].line_total).toBe(500);
  });

  it("derives totals from items only (items-as-truth)", () => {
    const { snapshot } = buildPaymentReceiptSnapshot(PAYMENT, ALLOCS);
    expect(snapshot.subtotal).toBe(1500);
    expect(snapshot.tax_amount).toBe(0);
    expect(snapshot.total).toBe(1500);
    expect(snapshot.amount_paid).toBe(1500);
  });

  it("suppresses unapplied when restricted to a single invoice", () => {
    const { snapshot } = buildPaymentReceiptSnapshot(PAYMENT, ALLOCS, "inv-a");
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].description).toContain("INV-001");
    expect(snapshot.total).toBe(400);
    expect(snapshot.unapplied_amount).toBe(0);
  });

  it("emits On-account payment when no allocations exist", () => {
    const { snapshot } = buildPaymentReceiptSnapshot(PAYMENT, []);
    const items = snapshot.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("On-account payment");
    expect(items[0].line_total).toBe(1500);
    expect(snapshot.total).toBe(1500);
  });

  it("picks uniform allocation currency, else falls back to payment/business/USD", () => {
    const mixed: PaymentAllocationRow[] = [
      { ...ALLOCS[0], invoices: { ...ALLOCS[0].invoices!, currency: "USD" } },
      { ...ALLOCS[1], invoices: { ...ALLOCS[1].invoices!, currency: "KES" } },
    ];
    expect(buildPaymentReceiptSnapshot(PAYMENT, mixed).currency).toBe("KES");
    const uniform = buildPaymentReceiptSnapshot(PAYMENT, [
      { ...ALLOCS[0], invoices: { ...ALLOCS[0].invoices!, currency: "USD" } },
    ]);
    expect(uniform.currency).toBe("USD");
    const noAlloc = buildPaymentReceiptSnapshot(
      { ...PAYMENT, currency: null, business: { id: "b", name: "x", base_currency: null } },
      [],
    );
    expect(noAlloc.currency).toBe("USD");
  });

  it("maps payment_method through the display labels", () => {
    const { snapshot } = buildPaymentReceiptSnapshot(PAYMENT, ALLOCS);
    expect(snapshot.payment_method).toBe("Bank Transfer");
  });

  it("is deterministic: same input → byte-identical snapshot JSON", () => {
    const a = JSON.stringify(buildPaymentReceiptSnapshot(PAYMENT, ALLOCS).snapshot);
    const b = JSON.stringify(buildPaymentReceiptSnapshot(PAYMENT, ALLOCS).snapshot);
    expect(a).toBe(b);
  });

  it("throws when required identity fields are missing", () => {
    expect(() => buildPaymentReceiptSnapshot({ ...PAYMENT, id: "" }, ALLOCS)).toThrow();
    expect(() => buildPaymentReceiptSnapshot({ ...PAYMENT, payment_date: "" }, ALLOCS)).toThrow();
  });
});