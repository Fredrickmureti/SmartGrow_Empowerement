/**
 * Borrower-facing repayment schedule snapshot.
 *
 * These tests protect the document's authority rules:
 *   - every installment figure is projected from the stored schedule rows
 *     (nothing recalculated), and the totals reconcile with them exactly;
 *   - an upfront-interest loan still shows principal and interest separately
 *     and reconciles to the gross contractual total, with the net cash paid
 *     out reported as its own fact;
 *   - a penalty appears only where one was actually assessed;
 *   - internal accounting-only fields never reach the borrower rows.
 */
import { describe, expect, it } from "vitest";

import { fetchAndBuildRepaymentScheduleSnapshot } from "@/services/documents/snapshots/lending";

type Row = Record<string, unknown>;

/** Minimal thenable Supabase stub: one canned result per table. */
function stubClient(tables: Record<string, Row | Row[] | null>) {
  const make = (table: string) => {
    const data = table in tables ? tables[table] : null;
    const settle = () => Promise.resolve({ data, error: null });
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const q: any = {
      single: settle,
      maybeSingle: settle,
      then: (res: any, rej: any) => settle().then(res, rej),
    };
    for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
    return q;
  };
  return { from: (table: string) => make(table) } as any;
}

const business = {
  id: "b1",
  organization_id: "org1",
  name: "Smart Grow Empowerment",
  base_currency: "KES",
};

const baseLoan = {
  id: "loan1",
  business_id: "b1",
  branch_id: "br1",
  loan_number: "LN-0001",
  client_id: "c1",
  product_id: "p1",
  loan_officer_id: null,
  currency_code: "KES",
  principal: 10000,
  term_installments: 12,
  repayment_frequency: "monthly",
  interest_method: "flat",
  interest_rate: 20,
  interest_collection: "with_installment",
  penalty_rate: 5,
  penalty_basis: "outstanding_principal",
  status: "active",
  lineage_kind: "new",
  disbursed_at: "2026-01-05",
};

/** Flat loan, interest collected inside the installment. */
function flatSchedule(): Row[] {
  const rows: Row[] = [];
  let opening = 12000;
  for (let i = 1; i <= 12; i += 1) {
    const total = 1000;
    rows.push({
      id: `s${i}`,
      installment_no: i,
      due_date: `2026-${String(i).padStart(2, "0")}-05`,
      opening_balance: opening,
      principal_due: 833.33,
      interest_due: 166.67,
      principal_component: 833.33,
      interest_component: 166.67,
      fees_due: 0,
      total_due: total,
      closing_balance: opening - total,
      is_grace: false,
      // internal-only noise the borrower document must drop
      interest_recognised: 100,
      journal_entry_id: "je-1",
    });
    opening -= total;
  }
  return rows;
}

/** Upfront-interest loan: stored interest is zero, the view re-splits it. */
function upfrontSchedule(): Row[] {
  const rows: Row[] = [];
  let opening = 10000;
  for (let i = 1; i <= 12; i += 1) {
    const total = i === 12 ? 833.37 : 833.33;
    rows.push({
      id: `u${i}`,
      installment_no: i,
      due_date: `2026-${String(i).padStart(2, "0")}-05`,
      opening_balance: opening,
      principal_due: total,
      interest_due: 0,
      principal_component: i === 12 ? 666.7 : 666.67,
      interest_component: 166.67,
      fees_due: 0,
      total_due: total,
      closing_balance: opening - total,
      is_grace: false,
    });
    opening -= total;
  }
  return rows;
}

const round = (v: number) => Math.round(v * 100) / 100;

describe("borrower repayment schedule snapshot", () => {
  it("projects the stored flat schedule and reconciles its totals", async () => {
    const schedule = flatSchedule();
    const supabase = stubClient({
      mf_loans: baseLoan,
      businesses: business,
      mf_clients: { full_name: "Jane Doe", client_number: "CL-0001" },
      mf_loan_products: { id: "p1", code: "FLAT", name: "Flat 20%" },
      branches: { id: "br1", name: "Nairobi" },
      mf_loan_schedule_display: schedule,
      mf_loan_disbursements: {
        net_amount: 10000,
        upfront_interest: 0,
        fees_deducted: 0,
      },
      mf_loan_penalty_status: [],
      mf_loan_balances: { total_outstanding: 12000, next_due_date: "2026-01-05" },
    });

    const { snapshot, currency, documentNumber } =
      await fetchAndBuildRepaymentScheduleSnapshot(supabase, "loan1");
    const rows = snapshot["schedule"] as Row[];
    const totals = snapshot["schedule_totals"] as Record<string, number>;

    expect(documentNumber).toBe("LN-0001");
    expect(currency).toBe("KES");
    expect(rows).toHaveLength(12);
    expect(round(totals["total"])).toBe(12000);
    expect(round(totals["principal"])).toBe(9999.96);
    expect(round(totals["interest"])).toBe(2000.04);
    expect(totals["penalty"]).toBe(0);
    expect(snapshot["installment_count"]).toBe(12);
    expect(snapshot["maturity_date"]).toBe("2026-12-05");
    // rows carry only borrower-facing fields
    for (const r of rows) {
      expect(r["interest_recognised"]).toBeUndefined();
      expect(r["journal_entry_id"]).toBeUndefined();
    }
    expect(rows.every((r) => r["penalty_due"] === 0)).toBe(true);
  });

  it("shows principal and interest separately on an upfront-interest loan", async () => {
    const schedule = upfrontSchedule();
    const supabase = stubClient({
      mf_loans: { ...baseLoan, interest_collection: "deducted_upfront" },
      businesses: business,
      mf_clients: { full_name: "Jane Doe", client_number: "CL-0001" },
      mf_loan_products: { id: "p1", code: "UP", name: "Upfront 20%" },
      branches: { id: "br1", name: "Nairobi" },
      mf_loan_schedule_display: schedule,
      mf_loan_disbursements: {
        net_amount: 8000,
        upfront_interest: 2000,
        fees_deducted: 0,
      },
      mf_loan_penalty_status: [],
      mf_loan_balances: { total_outstanding: 10000, next_due_date: "2026-01-05" },
    });

    const { snapshot } = await fetchAndBuildRepaymentScheduleSnapshot(supabase, "loan1");
    const totals = snapshot["schedule_totals"] as Record<string, number>;

    expect(round(totals["total"])).toBe(10000);
    expect(round(totals["interest"])).toBe(2000.04);
    expect(round(totals["principal"])).toBe(8000.07);
    expect(snapshot["net_cash_disbursed"]).toBe(8000);
    expect(snapshot["upfront_interest_withheld"]).toBe(2000);
    expect(snapshot["interest_collection"]).toBe("deducted_upfront");
    expect(round(snapshot["total_scheduled_repayment"] as number)).toBe(10000);
  });

  it("carries a penalty only on the installment where one was assessed", async () => {
    const schedule = flatSchedule();
    const supabase = stubClient({
      mf_loans: baseLoan,
      businesses: business,
      mf_clients: { full_name: "Jane Doe", client_number: "CL-0001" },
      mf_loan_products: { id: "p1", code: "FLAT", name: "Flat 20%" },
      branches: { id: "br1", name: "Nairobi" },
      mf_loan_schedule_display: schedule,
      mf_loan_disbursements: { net_amount: 10000, upfront_interest: 0, fees_deducted: 0 },
      mf_loan_penalty_status: [
        { installment_no: 2, penalty_charged: 150, penalty_paid: 50, penalty_outstanding: 100 },
      ],
      mf_loan_balances: { total_outstanding: 12100, next_due_date: "2026-02-05" },
    });

    const { snapshot } = await fetchAndBuildRepaymentScheduleSnapshot(supabase, "loan1");
    const rows = snapshot["schedule"] as Row[];
    const totals = snapshot["schedule_totals"] as Record<string, number>;

    expect(rows[1]["penalty_due"]).toBe(100);
    expect(rows.filter((r) => Number(r["penalty_due"]) !== 0)).toHaveLength(1);
    expect(totals["penalty"]).toBe(100);
  });

  it("fails instead of inventing a document when the loan is not readable", async () => {
    const supabase = stubClient({ mf_loans: null });
    await expect(
      fetchAndBuildRepaymentScheduleSnapshot(supabase, "loan-not-mine"),
    ).rejects.toThrow(/not found/);
  });
});
