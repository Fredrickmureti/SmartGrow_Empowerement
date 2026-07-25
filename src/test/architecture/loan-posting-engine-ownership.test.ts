/**
 * Architecture guard — Loans emit events, Finance owns posting.
 *
 * The `23502 entry_number` failure on `employee_loan_disburse` came from the
 * loan module hand-rolling `INSERT INTO journal_entries` instead of calling
 * the canonical Finance engine (`post_journal_entry_atomic`) with a number
 * from `generate_next_je_number`. This guard fails if any loan RPC drifts
 * back to a private posting implementation.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Latest definition of each loan RPC across the migration history. */
function latestLoanMigrations(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  return files
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .filter((sql) => /FUNCTION public\.(employee_loan_|_loan_)/.test(sql));
}

/** Body of the LAST migration that (re)defines `fn`. */
function latestBody(fn: string): string | null {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = readFileSync(join(MIGRATIONS, files[i]), "utf8");
    const marker = `FUNCTION public.${fn}(`;
    const at = sql.indexOf(marker);
    if (at >= 0) return sql.slice(at);
  }
  return null;
}

describe("Loan module never owns GL posting", () => {
  it("the current employee_loan_disburse posts via the Finance engine", () => {
    const body = latestBody("employee_loan_disburse");
    expect(body, "employee_loan_disburse migration not found").toBeTruthy();
    const fn = body!.split("$function$")[1] ?? "";
    expect(fn).toContain("post_journal_entry_atomic");
    expect(fn).toContain("generate_next_je_number");
    expect(/INSERT INTO public\.journal_entries/i.test(fn)).toBe(false);
    expect(/INSERT INTO public\.journal_entry_lines/i.test(fn)).toBe(false);
  });

  it("every loan GL event uses a distinct source_type for idempotency", () => {
    const sources = ["loan_disbursement", "loan_repayment", "loan_repayment_reversal", "loan_write_off"];
    const all = latestLoanMigrations().join("\n");
    for (const s of sources) {
      expect(all.includes(`'${s}'`), `missing loan GL source_type ${s}`).toBe(true);
    }
  });

  it("loan RPCs never concatenate UUIDs into journal narration (ADR-0020)", () => {
    for (const fn of [
      "employee_loan_disburse",
      "employee_loan_record_manual_repayment",
      "employee_loan_write_off",
    ]) {
      const body = latestBody(fn) ?? "";
      const fnBody = body.split("$function$")[1] ?? "";
      expect(/_description\s*(:?=|=>)\s*[^,;]*_id::text/i.test(fnBody), `${fn} narration must not embed a UUID`).toBe(false);
    }
  });

  it("the disbursement UI keeps calling the RPC (no client-side posting)", () => {
    const hook = readFileSync(join(process.cwd(), "src/hooks/useEmployeeLoans.ts"), "utf8");
    expect(hook).toContain("employee_loan_disburse");
    expect(hook.includes('.from("journal_entries")')).toBe(false);
  });
});
