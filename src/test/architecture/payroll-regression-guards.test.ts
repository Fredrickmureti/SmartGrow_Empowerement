import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

function latestApprovePayrollRunSql(): string {
  const dir = resolve(ROOT, "supabase/migrations");
  const matches = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"))
    .filter((sql) => sql.includes("CREATE OR REPLACE FUNCTION public.approve_payroll_run"));
  expect(matches.length).toBeGreaterThan(0);
  return matches[matches.length - 1];
}

describe("payroll regression guards", () => {
  it("lifecycle gate uses live payroll column names", () => {
    const src = read("supabase/functions/_shared/payrollLifecycleGate.ts");
    expect(src).toContain("pay_period_start");
    expect(src).toContain("pay_period_end");
    expect(src).toContain("start_date");
    expect(src).toContain("end_date");
    expect(src).not.toMatch(/\.select\(["']id, status, period_start, period_end["']\)/);
    expect(src).not.toMatch(/\.lte\(["']period_start["']/);
    expect(src).not.toMatch(/\.gte\(["']period_end["']/);
  });

  it("tax certificate generator is artifact-first", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).toContain("artifacts: artifactsList");
    expect(src).not.toMatch(/\.select\(["'][^"']*xlsx_path/);
    expect(src).not.toMatch(/xlsx_path:\s*xlsxPath/);
  });

  it("approve payroll is idempotent for already-approved runs", () => {
    const sql = latestApprovePayrollRunSql();
    expect(sql).toMatch(/IF\s+v_run\.status\s*=\s*'approved'\s+THEN\s+RETURN\s+v_run;/i);
  });

  it("compute-payroll returns existing regular runs as structured idempotent success", () => {
    const src = read("supabase/functions/compute-payroll/index.ts");
    expect(src).toContain("REGULAR_RUN_EXISTS");
    expect(src).toContain("payroll_run: existingRegular");
    expect(src).toContain("reused: true");
    expect(src).toContain("isDuplicatePayrollNumber");
  });
});