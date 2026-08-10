/**
 * Customer statement snapshot builder — contract test.
 *
 * The builder is a pure projection of the canonical dataset folded from
 * `customer_ledger_entries`. It must never re-derive balances, and it must
 * be deterministic (no clock).
 */
import { describe, it, expect } from "vitest";
import {
  buildCustomerStatementSnapshot,
  type BuildStatementInput,
  type StatementHeaderRow,
} from "@/services/documents/snapshots/salesCustomerStatement";
import { buildStatementDataset } from "@/services/finance/customerStatementDataset";

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

const dataset = buildStatementDataset({
  rows: [
    // Opening: before the period.
    { entry_date: "2026-05-20", doc_type: "invoice", doc_id: "i-0", doc_ref: "INV-000", debit: 500, credit: 0, currency: "KES", created_at: "2026-05-20T00:00:00Z" },
    { entry_date: "2026-06-05", doc_type: "invoice", doc_id: "i-1", doc_ref: "INV-001", debit: 400, credit: 0, currency: "KES", created_at: "2026-06-05T00:00:00Z" },
    { entry_date: "2026-06-10", doc_type: "payment", doc_id: "p-1", doc_ref: "RCP-1", debit: 0, credit: 400, currency: "KES", created_at: "2026-06-10T00:00:00Z" },
    { entry_date: "2026-06-15", doc_type: "invoice", doc_id: "i-2", doc_ref: "INV-002", debit: 600, credit: 0, currency: "KES", created_at: "2026-06-15T00:00:00Z" },
    { entry_date: "2026-06-20", doc_type: "credit_note", doc_id: "cn-1", doc_ref: "CN-01", debit: 0, credit: 100, currency: "KES", created_at: "2026-06-20T00:00:00Z" },
  ],
  periodStart: "2026-06-01",
  periodEnd: "2026-06-30",
  currency: "KES",
});

const BASE: BuildStatementInput = {
  statement: STMT,
  dataset,
  aging: { not_due: 0, current: 0, days30: 600, days60: 0, days90: 0, total: 600 },
};

describe("buildCustomerStatementSnapshot", () => {
  it("emits customer_statement document_type + label + number", () => {
    const { snapshot, documentNumber } = buildCustomerStatementSnapshot(BASE);
    expect(snapshot.document_type).toBe("customer_statement");
    expect(snapshot.document_type_label).toBe("CUSTOMER STATEMENT");
    expect(documentNumber).toBe("Statement - Acme Ltd");
  });

  it("projects the dataset's ordering and running balance verbatim", () => {
    const { snapshot } = buildCustomerStatementSnapshot(BASE);
    const txns = snapshot.statement_transactions as Array<Record<string, unknown>>;
    expect(txns).toHaveLength(4);
    expect(txns.map((t) => t.reference)).toEqual(["INV-001", "RCP-1", "INV-002", "CN-01"]);
    // opening 500 → 900 → 500 → 1100 → 1000
    expect(txns.map((t) => t.balance)).toEqual([900, 500, 1100, 1000]);
  });

  it("takes opening and closing balances from the ledger, not the header", () => {
    const { snapshot } = buildCustomerStatementSnapshot({
      ...BASE,
      statement: { ...STMT, opening_balance: 99999, closing_balance: 1234 },
    });
    expect(snapshot.statement_opening_balance).toBe(500);
    expect(snapshot.statement_closing_balance).toBe(1000);
    expect(snapshot.total).toBe(1000);
  });

  it("renders the canonical aging buckets it is given", () => {
    const { snapshot } = buildCustomerStatementSnapshot(BASE);
    expect(snapshot.statement_aging).toEqual([
      { label: "Not yet due", amount: 0 },
      { label: "0–30 days", amount: 0 },
      { label: "31–60 days", amount: 600 },
      { label: "61–90 days", amount: 0 },
      { label: "90+ days", amount: 0 },
    ]);
  });

  it("discloses activity in other currencies instead of summing it", () => {
    const mixed = buildStatementDataset({
      rows: [
        { entry_date: "2026-06-05", doc_type: "invoice", doc_id: "i-1", doc_ref: "INV-001", debit: 400, credit: 0, currency: "KES", created_at: "2026-06-05T00:00:00Z" },
        { entry_date: "2026-06-06", doc_type: "invoice", doc_id: "i-9", doc_ref: "INV-009", debit: 900, credit: 0, currency: "USD", created_at: "2026-06-06T00:00:00Z" },
      ],
      periodStart: "2026-06-01",
      periodEnd: "2026-06-30",
      currency: "KES",
    });
    const { snapshot } = buildCustomerStatementSnapshot({ statement: STMT, dataset: mixed });
    expect(snapshot.statement_closing_balance).toBe(400);
    expect(String(snapshot.notes)).toContain("USD");
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

  it("is deterministic — no ambient clock", () => {
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
