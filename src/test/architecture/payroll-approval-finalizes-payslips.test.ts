/**
 * Architecture guard — payroll approval is the legal finalisation event for
 * accrual-basis returns. Approving a run must therefore finalize its computed
 * payslips to `approved`; otherwise P10/PAYE readiness incorrectly blocks on
 * `pending` payslips even though the run itself is immutable and posted.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const MIGRATIONS = resolve(ROOT, "supabase/migrations");

function latestApprovePayrollRunDefinition(): string {
  const candidates = readdirSync(MIGRATIONS)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }))
    .filter(({ sql }) => sql.includes("CREATE OR REPLACE FUNCTION public.approve_payroll_run"));

  expect(candidates.length).toBeGreaterThan(0);
  return candidates[candidates.length - 1].sql;
}

describe("payroll approval finalizes payslip lifecycle", () => {
  it("approve_payroll_run promotes pending/draft payslips to approved, not paid", () => {
    const sql = latestApprovePayrollRunDefinition();

    expect(sql).toMatch(/UPDATE\s+public\.payroll_runs[\s\S]*SET\s+status\s*=\s*'approved'/i);
    expect(sql).toMatch(/UPDATE\s+public\.payslips[\s\S]*SET\s+status\s*=\s*'approved'/i);
    expect(sql).toMatch(/status\s+IN\s*\(\s*'pending'\s*,\s*'draft'\s*\)/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.payslips[\s\S]*SET\s+status\s*=\s*'paid'/i);
  });
});