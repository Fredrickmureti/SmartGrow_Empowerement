/**
 * Architecture ratchet — Single Journal Posting Engine.
 *
 * Invariants (see the settlement/posting convergence plan):
 *   1. No application code (src/** or supabase/functions/**) may insert
 *      into journal_entries / journal_entry_lines. Posting goes through
 *      the canonical post_journal_entry_atomic RPC.
 *   2. No application code may insert settlement rows (payments,
 *      payment_allocations, bill_payments, bill_payment_allocations)
 *      directly. Settlement is owned by the AR/AP settlement engines.
 *   3. The phantom `invoice_payments` table must never be referenced —
 *      it does not exist in the schema.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

function rgFiles(pattern: string, paths: string[]): string[] {
  try {
    return execSync(
      `rg -lU ${JSON.stringify(pattern)} ${paths.join(" ")} -g '*.ts' -g '*.tsx'`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      // The guard test itself contains the patterns it forbids.
      .filter((f) => !f.includes("journal-posting-monopoly.test.ts"));
  } catch {
    return [];
  }
}

const APP_PATHS = ["src", "supabase/functions"];

describe("Journal posting monopoly", () => {
  it("no application code inserts into journal_entries or journal_entry_lines", () => {
    const offenders = rgFiles(
      'from\\("journal_entr[a-z_]*"\\)\\s*\\.insert',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  it("no application code inserts settlement rows directly", () => {
    const offenders = rgFiles(
      'from\\("(payments|payment_allocations|bill_payments|bill_payment_allocations)"\\)\\s*\\.insert',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  it("the phantom invoice_payments table is never referenced", () => {
    const offenders = rgFiles('invoice_payments', APP_PATHS);
    expect(offenders).toEqual([]);
  });

  /**
   * Advance disbursement moves cash. It must therefore go through
   * `disburse_employee_advance`, which posts the receivable/bank entry
   * via the engine. A client-side status flip to 'disbursed' would move
   * money with no journal — the exact defect this ratchet freezes out.
   */
  it("no application code flips employee_advances to disbursed directly", () => {
    const offenders = rgFiles(
      'from\\("employee_advances"\\)[\\s\\S]{0,200}?"disbursed"',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * The recovery leg has the same single-writer rule: only
   * `process_payroll_advance_recoveries` may write repayment schedule rows,
   * so the schedule, the advance balance and the GL credit can never
   * disagree. Direct inserts from app or edge code reintroduce the drift.
   */
  it("only the recovery RPC writes advance_repayment_schedule", () => {
    const offenders = rgFiles(
      'from\\("advance_repayment_schedule"\\)[\\s\\S]{0,120}?\\.(insert|upsert|update)\\(',
      [...APP_PATHS, "supabase/functions"],
    );
    expect(offenders).toEqual([]);
  });

  /**
   * Reversal paths (void / unreconcile) recompute invoice balances inside
   * `void_payment_atomic` and `unreconcile_payment_atomic`. Client-side
   * writes to `invoices.amount_paid` re-open the window where the GL is
   * reversed but the invoice still counts the cash.
   */
  it("no application code writes invoices.amount_paid directly", () => {
    const offenders = rgFiles(
      'from\\("invoices"\\)[\\s\\S]{0,200}?amount_paid\\s*:',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * Deleting allocation rows destroys the settlement trail. Reversals append
   * compensating rows instead (ADR 0027 invariant 5).
   */
  it("no application code deletes payment allocation rows", () => {
    const offenders = rgFiles(
      'from\\("(payment_allocations|bill_payment_allocations)"\\)[\\s\\S]{0,120}?\\.delete\\(',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * ADR 0126 — AP parity. Supplier payment reversal is owned by
   * `void_bill_payment_atomic`; the browser may not decrement bill balances
   * nor delete the payment header (which would cascade the allocation trail
   * away).
   */
  it("no application code writes bills.amount_paid directly", () => {
    const offenders = rgFiles(
      'from\\("bills"\\)[\\s\\S]{0,200}?amount_paid\\s*:',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  it("no application code deletes bill_payments rows", () => {
    const offenders = rgFiles(
      'from\\("bill_payments"\\)[\\s\\S]{0,120}?\\.delete\\(',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  /**
   * ADR 0127 — invoice void is one server transaction
   * (`void_invoice_atomic`). The browser may not flip the void fields on
   * `invoices` itself, nor drive stock restoration separately: either would
   * reintroduce the partial-failure window where the GL is reversed but the
   * document or inventory still counts the sale.
   */
  it("no application code stamps invoice void fields directly", () => {
    const offenders = rgFiles(
      'from\\("invoices"\\)[\\s\\S]{0,300}?voided_at\\s*:',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  it("stock restoration is only driven from inside void_invoice_atomic", () => {
    const offenders = rgFiles("restore_invoice_stock_atomic", APP_PATHS)
      // Generated RPC typings legitimately name every function.
      .filter((f) => !f.includes("integrations/supabase/types.ts"));
    expect(offenders).toEqual([]);
  });

  /**
   * Phase 3 — bill void is one server transaction (`void_bill_atomic`).
   *
   * Two client-side sagas used to own this (`useBills.voidBill` and
   * `useTransactionReversal.voidBill`), each with its own guards and its own
   * ordering. The browser may not flip `bills.status` to void itself, and may
   * not release the three-way match, because a failure between those writes and
   * the journal reversal leaves the ledger and the purchase document
   * disagreeing.
   */
  it("no application code flips bills to void directly", () => {
    const offenders = rgFiles(
      'from\\("bills"\\)[\\s\\S]{0,200}?status:\\s*"void"',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  it("no application code stamps bill void metadata directly", () => {
    const offenders = rgFiles(
      'from\\("bills"\\)[\\s\\S]{0,300}?(voided_at|void_reason)\\s*:',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

  it("three-way-match release is only driven from inside void_bill_atomic", () => {
    const offenders = rgFiles(
      'from\\("bill_match_results"\\)[\\s\\S]{0,120}?\\.delete\\(',
      APP_PATHS,
    );
    expect(offenders).toEqual([]);
  });

});





