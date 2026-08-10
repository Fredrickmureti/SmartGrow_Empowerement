import { describe, it, expect } from "vitest";
import {
  buildVendorStatementSnapshot,
  type VendorStatementHeaderRow,
} from "@/services/documents/snapshots/purchasesVendorStatement";
import {
  buildVendorStatementDataset,
  type VendorLedgerRow,
} from "@/services/finance/vendorStatementDataset";
import { EMPTY_AGING_BUCKETS } from "@/services/finance/aging";

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

// `vendor_ledger_entries` convention: credit increases what we owe (bill),
// debit decreases it (payment / vendor credit).
const ROWS: VendorLedgerRow[] = [
  // Prior period → opening balance of 100.
  { entry_date: "2026-05-02", doc_type: "bill", doc_id: "b-0", doc_ref: "B-0", debit: 0, credit: 100, currency: "KES", created_at: "2026-05-02T00:00:00Z" },
  { entry_date: "2026-06-10", doc_type: "bill", doc_id: "b-1", doc_ref: "B-1", debit: 0, credit: 500, currency: "KES", created_at: "2026-06-10T00:00:00Z" },
  { entry_date: "2026-06-15", doc_type: "bill_payment", doc_id: "p-1", doc_ref: "PAY-1", debit: 200, credit: 0, currency: "KES", created_at: "2026-06-15T00:00:00Z" },
  { entry_date: "2026-06-20", doc_type: "vendor_credit_note", doc_id: "c-1", doc_ref: "VCN-1", debit: 50, credit: 0, currency: "KES", created_at: "2026-06-20T00:00:00Z" },
];

const dataset = () =>
  buildVendorStatementDataset({
    rows: ROWS,
    periodStart: HEADER.period_start,
    periodEnd: HEADER.period_end,
    currency: "KES",
  });

describe("buildVendorStatementSnapshot", () => {
  it("emits document_type / label / number", () => {
    const { snapshot, documentNumber } = buildVendorStatementSnapshot({
      statement: HEADER,
      dataset: dataset(),
    });
    expect(snapshot.document_type).toBe("vendor_statement");
    expect(snapshot.document_type_label).toBe("VENDOR STATEMENT");
    expect(documentNumber).toBe("Vendor Statement - Widgets Supplier Ltd");
  });

  it("folds the ledger into a running balance", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: HEADER,
      dataset: dataset(),
    });
    const txns = snapshot.statement_transactions as Array<{ balance: number; type: string }>;
    expect(snapshot.statement_opening_balance).toBe(100);
    expect(txns.length).toBe(3);
    // Opening 100 + Bill 500 = 600, − Payment 200 = 400, − Vendor credit 50 = 350
    expect(txns[0].type).toBe("Bill");
    expect(txns[0].balance).toBe(600);
    expect(txns[1].type).toBe("Payment");
    expect(txns[1].balance).toBe(400);
    expect(txns[2].type).toBe("Vendor Credit");
    expect(txns[2].balance).toBe(350);
    expect(snapshot.statement_closing_balance).toBe(350);
    expect(snapshot.total).toBe(350);
  });

  it("closing balance comes from the ledger, never the stored header column", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: { ...HEADER, closing_balance: 999, opening_balance: 999 },
      dataset: dataset(),
    });
    expect(snapshot.statement_closing_balance).toBe(350);
    expect(snapshot.statement_opening_balance).toBe(100);
  });

  it("projects the canonical aging buckets it is given", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: HEADER,
      dataset: dataset(),
      aging: { ...EMPTY_AGING_BUCKETS, days30: 300 },
    });
    const aging = snapshot.statement_aging as Array<{ label: string; amount: number }>;
    expect(aging.reduce((s, a) => s + a.amount, 0)).toBe(300);
  });

  it("defaults aging to zeroes when none is supplied", () => {
    const { snapshot } = buildVendorStatementSnapshot({
      statement: HEADER,
      dataset: dataset(),
    });
    const aging = snapshot.statement_aging as Array<{ amount: number }>;
    expect(aging.reduce((s, a) => s + a.amount, 0)).toBe(0);
  });

  it("discloses other-currency activity instead of summing it", () => {
    const ds = buildVendorStatementDataset({
      rows: [
        ...ROWS,
        { entry_date: "2026-06-12", doc_type: "bill", doc_id: "b-9", doc_ref: "B-9", debit: 0, credit: 1000, currency: "USD", created_at: "2026-06-12T00:00:00Z" },
      ],
      periodStart: HEADER.period_start,
      periodEnd: HEADER.period_end,
      currency: "KES",
    });
    const { snapshot } = buildVendorStatementSnapshot({ statement: HEADER, dataset: ds });
    expect(snapshot.statement_closing_balance).toBe(350);
    expect(String(snapshot.notes)).toContain("USD");
  });

  it("emits deterministic snapshots", () => {
    const a = buildVendorStatementSnapshot({ statement: HEADER, dataset: dataset() });
    const b = buildVendorStatementSnapshot({ statement: HEADER, dataset: dataset() });
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

  it("throws on missing identity/period fields", () => {
    expect(() =>
      buildVendorStatementSnapshot({ statement: { ...HEADER, id: "" }, dataset: dataset() }),
    ).toThrow(/id required/);
    expect(() =>
      buildVendorStatementSnapshot({
        statement: { ...HEADER, period_start: "" },
        dataset: dataset(),
      }),
    ).toThrow(/period_start/);
  });
});
