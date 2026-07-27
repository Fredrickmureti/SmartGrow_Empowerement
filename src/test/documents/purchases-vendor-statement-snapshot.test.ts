import { describe, it, expect } from "vitest";
import {
  buildVendorStatementSnapshot,
  type VendorStatementHeaderRow,
  type VendorStatementBillRow,
  type VendorStatementPaymentRow,
  type VendorStatementCreditNoteRow,
} from "@/services/documents/snapshots/purchasesVendorStatement";

const HEADER: VendorStatementHeaderRow = {
  id: "vs-1",
  contact_id: "v-1",
  vendor_id: "v-1",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: null,
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  statement_date: "2026-06-30",
  created_at: "2026-06-30T00:00:00Z",
  opening_balance: 100,
  closing_balance: null,
  total_billed: 500,
  total_payments: 200,
  sent_at: null,
  contact: { name: "Widgets Supplier Ltd" },
  business: { id: "biz-1", name: "Acme", base_currency: "KES" },
};
const BILLS: VendorStatementBillRow[] = [
  { bill_number: "B-1", bill_date: "2026-06-10", total: 500, amount_paid: 200, status: "partial", vendor_invoice_number: "VI-9" },
];
const PMTS: VendorStatementPaymentRow[] = [
  { reference: "PAY-1", payment_date: "2026-06-15", amount: 200 },
];
const CNS: VendorStatementCreditNoteRow[] = [
  { credit_note_number: "VCN-1", credit_date: "2026-06-20", total: 50, status: "confirmed" },
];

describe("buildVendorStatementSnapshot", () => {
  const NOW = new Date("2026-07-27T00:00:00Z");
  it("emits document_type / label / number", () => {
    const { snapshot, documentNumber } = buildVendorStatementSnapshot({
      statement: HEADER, bills: BILLS, payments: PMTS, creditNotes: CNS, now: NOW,
    });
    expect(snapshot.document_type).toBe("vendor_statement");
    expect(snapshot.document_type_label).toBe("VENDOR STATEMENT");
    expect(documentNumber).toBe("Vendor Statement - Widgets Supplier Ltd");
  });

  it("computes running balance across bill/payment/credit-note rows", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: HEADER, bills: BILLS, payments: PMTS, creditNotes: CNS, now: NOW,
    });
    const txns = snapshot.statement_transactions as Array<{ balance: number; type: string }>;
    expect(txns.length).toBe(3);
    // Opening 100 + Bill 500 = 600, - Payment 200 = 400, - CN 50 = 350
    expect(txns[0].type).toBe("Bill");
    expect(txns[0].balance).toBe(600);
    expect(txns[1].balance).toBe(400);
    expect(txns[2].balance).toBe(350);
    expect(snapshot.statement_closing_balance).toBe(350);
  });

  it("uses closing_balance override when provided", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: { ...HEADER, closing_balance: 999 },
      bills: BILLS, payments: PMTS, creditNotes: CNS, now: NOW,
    });
    expect(snapshot.statement_closing_balance).toBe(999);
    expect(snapshot.total).toBe(999);
  });

  it("aging buckets 45 days old → 31-60", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: HEADER, bills: BILLS, payments: [], creditNotes: [], now: new Date("2026-07-25T00:00:00Z"),
    });
    const aging = snapshot.statement_aging as Array<{ label: string; amount: number }>;
    expect(aging.find(a => a.label === "31-60 Days")!.amount).toBe(300);
  });

  it("skips fully-paid bills from aging", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: HEADER,
      bills: [{ ...BILLS[0], amount_paid: 500 }],
      payments: [], creditNotes: [], now: NOW,
    });
    const aging = snapshot.statement_aging as Array<{ amount: number }>;
    expect(aging.reduce((s, a) => s + a.amount, 0)).toBe(0);
  });

  it("emits deterministic snapshots", () => {
    const a = buildVendorStatementSnapshot({ statement: HEADER, bills: BILLS, payments: PMTS, creditNotes: CNS, now: NOW });
    const b = buildVendorStatementSnapshot({ statement: HEADER, bills: BILLS, payments: PMTS, creditNotes: CNS, now: NOW });
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("throws on missing identity/period fields", () => {
    expect(() => buildVendorStatementSnapshot({ statement: { ...HEADER, id: "" }, bills: [], payments: [], creditNotes: [] }))
      .toThrow(/id required/);
    expect(() => buildVendorStatementSnapshot({ statement: { ...HEADER, period_start: "" }, bills: [], payments: [], creditNotes: [] }))
      .toThrow(/period_start/);
  });
});
