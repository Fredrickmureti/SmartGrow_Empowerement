/**
 * Wave 7.2 · Step 6 — customer statement snapshot builder unit test.
 *
 * Locks the running-balance, stable-sort, and aging-bucket contract
 * defined by `fetchCustomerStatement` (generate-document).
 */
import { describe, it, expect } from "vitest";
import {
  buildCustomerStatementSnapshot,
  type BuildStatementInput,
  type StatementHeaderRow,
} from "@/services/documents/snapshots/salesCustomerStatement";

const STMT: StatementHeaderRow = {
  id: "stmt-1",
  contact_id: "c-1",
  organization_id: "org-1",
  business_id: "biz-1",
  branch_id: null,
  period_start: "2026-06-01",
  period_end: "2026-06-30",
  statement_date: "2026-07-01",
  created_at: "2026-07-01T00:00:00Z",
  opening_balance: 500,
  closing_balance: null,
  total_invoiced: 1000,
  total_payments: 400,
  sent_at: null,
  contact: { name: "Acme Ltd", email: "ap@acme.test" },
  business: { id: "biz-1", name: "Widget Co", base_currency: "KES" },
};

const BASE: BuildStatementInput = {
  statement: STMT,
  invoices: [
    { invoice_number: "INV-002", issue_date: "2026-06-15", total: 600, amount_paid: 0, status: "sent" },
    { invoice_number: "INV-001", issue_date: "2026-06-05", total: 400, amount_paid: 400, status: "paid" },
  ],
  payments: [
    { receipt_number: "RCP-1", payment_date: "2026-06-10", amount: 400, payment_method: "cash" },
  ],
  creditNotes: [
    { credit_note_number: "CN-01", issue_date: "2026-06-20", total: 100, status: "issued" },
  ],
  now: new Date("2026-07-27T00:00:00Z"),
};

describe("buildCustomerStatementSnapshot", () => {
  it("emits customer_statement document_type + label + number", () => {
    const { snapshot, documentNumber } = buildCustomerStatementSnapshot(BASE);
    expect(snapshot.document_type).toBe("customer_statement");
    expect(snapshot.document_type_label).toBe("CUSTOMER STATEMENT");
    expect(documentNumber).toBe("Statement - Acme Ltd");
  });

  it("sorts transactions by date then type/reference and runs balance from opening", () => {
    const { snapshot } = buildCustomerStatementSnapshot(BASE);
    const txns = snapshot.statement_transactions as Array<Record<string, unknown>>;
    expect(txns).toHaveLength(4);
    expect(txns.map((t) => t.reference)).toEqual(["INV-001", "RCP-1", "INV-002", "CN-01"]);
    // opening 500 + 400 - 0 = 900, - 400 = 500, + 600 = 1100, - 100 = 1000
    expect(txns.map((t) => t.balance)).toEqual([900, 500, 1100, 1000]);
  });

  it("falls back to running balance when closing_balance is null", () => {
    const { snapshot } = buildCustomerStatementSnapshot(BASE);
    expect(snapshot.statement_closing_balance).toBe(1000);
    expect(snapshot.total).toBe(1000);
  });

  it("honors explicit closing_balance from the header", () => {
    const { snapshot } = buildCustomerStatementSnapshot({
      ...BASE,
      statement: { ...STMT, closing_balance: 1234 },
    });
    expect(snapshot.statement_closing_balance).toBe(1234);
    expect(snapshot.total).toBe(1234);
  });

  it("computes 5-bucket aging from unpaid invoice balances only", () => {
    const { snapshot } = buildCustomerStatementSnapshot(BASE);
    const buckets = snapshot.statement_aging as Array<Record<string, unknown>>;
    // now = 2026-07-27; INV-002 (2026-06-15) = 42 days → 31-60 bucket, balance 600.
    // INV-001 fully paid → skipped.
    expect(buckets).toEqual([
      { label: "Current", amount: 0 },
      { label: "1-30 Days", amount: 0 },
      { label: "31-60 Days", amount: 600 },
      { label: "61-90 Days", amount: 0 },
      { label: "90+ Days", amount: 0 },
    ]);
  });

  it("marks status 'sent' iff sent_at is set", () => {
    expect(buildCustomerStatementSnapshot(BASE).snapshot.status).toBe("draft");
    const sent = buildCustomerStatementSnapshot({
      ...BASE,
      statement: { ...STMT, sent_at: "2026-07-02T09:00:00Z" },
    });
    expect(sent.snapshot.status).toBe("sent");
  });

  it("resolves currency from business.base_currency, else USD", () => {
    expect(buildCustomerStatementSnapshot(BASE).currency).toBe("KES");
    const usd = buildCustomerStatementSnapshot({
      ...BASE,
      statement: { ...STMT, business: { id: "b", name: "x", base_currency: null } },
    });
    expect(usd.currency).toBe("USD");
  });

  it("is deterministic when `now` is fixed", () => {
    const a = JSON.stringify(buildCustomerStatementSnapshot(BASE).snapshot);
    const b = JSON.stringify(buildCustomerStatementSnapshot(BASE).snapshot);
    expect(a).toBe(b);
  });

  it("throws when identity fields are missing", () => {
    expect(() =>
      buildCustomerStatementSnapshot({ ...BASE, statement: { ...STMT, id: "" } }),
    ).toThrow();
    expect(() =>
      buildCustomerStatementSnapshot({
        ...BASE,
        statement: { ...STMT, period_start: "" },
      }),
    ).toThrow();
  });
});