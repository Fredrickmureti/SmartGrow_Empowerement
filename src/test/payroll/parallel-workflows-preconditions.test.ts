/**
 * Parallel-workflow lifecycle guards (plan §Phase 2 / §Phase 5g).
 *
 * These are source-level regression tests: they pin the fact that the
 * three statutory-facing edge functions gate on **payroll Approval**
 * (`payroll_runs.approved_at IS NOT NULL`), NOT on Payment / GL Posting
 * status. Rewriting any of these preconditions in terms of `status='paid'`
 * or `status='posted'` fails the build — matches how SAP HCM / Workday /
 * Oracle HCM model statutory reporting as a peer workflow of Payment.
 *
 * They also pin the shape of the two RPCs whose signature drift caused the
 * original 500 (`payroll_employee_ytd_rollup`) and 400
 * (`payroll_remittance_dashboard`) errors on the compliance dashboard.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(rel: string) {
  return readFileSync(resolve(__dirname, "../../../", rel), "utf8");
}

describe("Statutory workflows depend on Approval, not Payment (plan §Phase 2)", () => {
  it("generate-statutory-return gates on payroll_runs.approved_at", () => {
    const src = read("supabase/functions/generate-statutory-return/index.ts");
    expect(src).toMatch(/\.not\(["']approved_at["'],\s*["']is["'],\s*null\)/);
    expect(src).toContain("NO_APPROVED_PAYROLL_RUNS");
    // Explicitly forbid the legacy anti-pattern where returns required paid payslips.
    expect(src).not.toMatch(/\.eq\(["']status["'],\s*["']paid["']\)/);
  });

  it("generate-tax-certificate gates on payroll_runs.approved_at (Phase 5g)", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).toMatch(/\.not\(["']approved_at["'],\s*["']is["'],\s*null\)/);
    expect(src).toContain("NO_APPROVED_PAYROLL_RUNS");
    expect(src).toContain("businessError");
    expect(src).not.toMatch(/\.eq\(["']status["'],\s*["']paid["']\)/);
  });

  it("post-payroll-gl gates on payroll_runs.approved_at", () => {
    const src = read("supabase/functions/post-payroll-gl/index.ts");
    expect(src).toMatch(/approved_at/);
    expect(src).not.toMatch(/payroll_runs\.status\s*=\s*["']paid["']/);
  });
});

describe("Compliance RPC signatures (plan §Phase 5g)", () => {
  it("generate-tax-certificate calls payroll_employee_ytd_rollup with the canonical arg names", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).toMatch(/rpc\(["']payroll_employee_ytd_rollup["']/);
    expect(src).toMatch(/p_year:\s*body\.fiscal_year/);
    expect(src).toMatch(/p_employee_id:\s*emp\.id/);
  });

  it("RemittanceOperatorDashboard calls payroll_remittance_dashboard(p_organization_id, p_business_id)", () => {
    const src = read("src/components/payroll/RemittanceOperatorDashboard.tsx");
    expect(src).toMatch(/rpc\(["']payroll_remittance_dashboard["']/);
    expect(src).toMatch(/p_organization_id:/);
    expect(src).toMatch(/p_business_id:/);
  });
});
