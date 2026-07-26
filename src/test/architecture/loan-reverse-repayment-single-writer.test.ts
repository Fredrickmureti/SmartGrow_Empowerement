/**
 * Phase 8 architecture guard — reverse-repayment single writer.
 *
 * The canonical write path for reversing a loan repayment is
 * `public.employee_loan_reverse_repayment`. No code outside the loan module
 * may:
 *   1. write to `public.loan_repayment_schedule` (schedule state is derived
 *      by the loan module's allocator + de-allocator),
 *   2. update `employee_loans` balance columns
 *      (`amount_repaid`, `outstanding_balance`, `installments_paid`), or
 *   3. insert `loan_repayments` rows with `kind='reversal'`.
 *
 * Phase 7 guard — the arrears sweep RPC exists and is scheduled.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rgFiles = (pattern: string, ...paths: string[]): string[] => {
  try {
    const out = execSync(
      `rg -l --no-messages -e ${JSON.stringify(pattern)} ${paths
        .map((p) => JSON.stringify(p))
        .join(" ")}`,
      { encoding: "utf8", cwd: resolve(__dirname, "../../../") },
    );
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "../../../", rel), "utf8");

describe("Loan reverse-repayment — single-writer discipline", () => {
  it("no code outside the loan module writes loan_repayment_schedule", () => {
    const offenders = rgFiles(
      "\\.from\\(\\s*[\"']loan_repayment_schedule[\"']\\s*\\)[\\s\\S]{0,120}\\.(update|insert|upsert|delete)",
      "src",
      "supabase/functions",
    ).filter(
      (f) =>
        !f.includes("integrations/supabase/types.ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx"),
    );
    expect(offenders).toEqual([]);
  });

  it("no code outside the loan module inserts a reversal-kind repayment", () => {
    const offenders = rgFiles(
      "kind:\\s*[\"']reversal[\"']",
      "src",
      "supabase/functions",
    ).filter(
      (f) =>
        !f.includes("integrations/supabase/types.ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx"),
    );
    expect(offenders).toEqual([]);
  });

  it("canonical reversal RPC exists and recomputes balances from the ledger", () => {
    const files = rgFiles(
      "employee_loan_reverse_repayment\\s*\\(",
      "supabase/migrations",
    ).sort();
    const latest = files[files.length - 1];
    expect(latest).toBeTruthy();
    const sql = read(latest);
    const idx = sql.lastIndexOf("employee_loan_reverse_repayment");
    const body = sql.slice(idx);
    // Recomputes from aggregates — no drift-prone in-place arithmetic.
    expect(body).toMatch(/SUM\(amount\)/i);
    expect(body).not.toMatch(/amount_repaid\s*-\s*orig\.amount/);
    expect(body).toMatch(/_loan_deallocate_schedule/);
    expect(body).toMatch(/_loan_assert_transition/);
  });
});

describe("Loan arrears — scheduled sweep", () => {
  it("canonical arrears-detection RPC exists in a committed migration", () => {
    const files = rgFiles(
      "employee_loan_mark_missed_installments\\s*\\(",
      "supabase/migrations",
    );
    expect(files.length).toBeGreaterThan(0);
  });

  it("arrears sweep is scheduled via pg_cron", () => {
    const files = rgFiles(
      "employee-loan-arrears-sweep",
      "supabase/migrations",
    );
    expect(files.length).toBeGreaterThan(0);
    const anyScheduled = files.some((f) =>
      /cron\.schedule\(\s*'employee-loan-arrears-sweep'/.test(read(f)),
    );
    expect(anyScheduled).toBe(true);
  });
});
