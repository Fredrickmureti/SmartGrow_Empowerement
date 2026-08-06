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
});

