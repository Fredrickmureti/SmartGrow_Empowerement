/**
 * Phase 6 regression guard — termination-settlement single-writer.
 *
 * The canonical write path for closing a loan on termination is
 * `public.employee_loan_close_on_termination`, which itself delegates to
 * `public.employee_loan_apply_repayment` (the Phase 2 single write path).
 * No other module — no edge function, no client hook, no other SQL
 * function outside the loan module — may write
 * `employee_loans.status = 'closed_on_termination'` directly or emit its
 * own final-settlement `loan_repayments` insert.
 *
 * This test fails fast if a future edit re-introduces that parallel-writer
 * pattern.
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

describe("Loan termination — single-writer discipline", () => {
  it("only the loan-module migration writes status='closed_on_termination'", () => {
    const offenders = rgFiles(
      "status\\s*=\\s*'closed_on_termination'",
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

  it("no code outside the loan module inserts a termination-kind repayment", () => {
    const offenders = rgFiles(
      "'termination_(recovery|writeoff)'",
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

  it("the canonical termination RPC exists in a committed migration", () => {
    const files = rgFiles(
      "employee_loan_close_on_termination\\(",
      "supabase/migrations",
    );
    expect(files.length).toBeGreaterThan(0);
    // At least one migration must define the 7-arg canonical form.
    const anyCanonical = files.some((f) =>
      read(f).includes("_writeoff_remaining boolean"),
    );
    expect(anyCanonical).toBe(true);
  });
});
