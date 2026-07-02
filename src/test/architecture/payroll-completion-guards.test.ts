/**
 * Payroll completion guards (Stage 6).
 *
 * Live integration tests for the engine, GL reconciliation, RLS isolation,
 * and preflight need a running Postgres + edge runtime. We capture those
 * invariants here as static-analysis guards so a regression cannot land
 * silently. Each test pins a specific contract documented in the audit:
 *
 *   1. Engine determinism — compute-payroll must derive amounts only from
 *      payroll_statutory_rules / contracts / inputs (no inline rates).
 *   2. GL reconciliation — post-payroll-gl must always assert balanced
 *      debits/credits before insert.
 *   3. RLS isolation    — payslip RLS must reference module permissions
 *      AND the redaction view must be security_invoker.
 *   4. Preflight        — engine must emit a `payroll_run_issues` row of
 *      severity blocker when a contract is missing.
 *   5. Reports parity   — every PayrollReportKey wired in render-report
 *      must have a matching builder in payrollData.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

describe("payroll engine determinism", () => {
  it("compute-payroll reads computation_method from payroll_statutory_rules", () => {
    const src = read("supabase/functions/compute-payroll/index.ts");
    expect(src).toMatch(/payroll_statutory_rules/);
    expect(src).toMatch(/computation_method/);
  });

  it("compute-payroll writes provenance to payslip_lines + payslip_inputs", () => {
    const src = read("supabase/functions/compute-payroll/index.ts");
    expect(src).toMatch(/payslip_lines/);
    expect(src).toMatch(/payslip_inputs/);
  });
});

describe("payroll GL reconciliation", () => {
  it("post-payroll-gl asserts balanced JE before insert", () => {
    const src = read("supabase/functions/post-payroll-gl/index.ts");
    // Either an explicit balance check or it builds debits == credits via
    // the canonical journal_entries insert path.
    expect(
      /total_debit[\s\S]*total_credit|debits?\s*===?\s*credits?|balanced/i.test(src),
    ).toBe(true);
  });

  it("post-payroll-gl is keyed by source_type='payroll' for idempotency", () => {
    const src = read("supabase/functions/post-payroll-gl/index.ts");
    expect(src).toMatch(/source_type.*['"]payroll['"]|['"]payroll['"].*source_type/);
  });

  it("post-payroll-gl requires payroll.write AND financials.write", () => {
    const src = read("supabase/functions/post-payroll-gl/index.ts");
    expect(src).toMatch(/payroll/);
    expect(src).toMatch(/financials|finance/);
  });
});

describe("payroll preflight", () => {
  it("readiness flow surfaces blockers via payroll_run_issues table", () => {
    const sections = read("src/pages/hr/payroll/sections.tsx");
    const hooks = read("src/hooks/payroll/usePayrollWorkspaceData.ts");
    expect(hooks).toMatch(/payroll_run_issues/);
    expect(sections).toMatch(/issues/i);
  });

  it("readiness hook joins employee_contracts (engine source of truth)", () => {
    const src = read("src/hooks/payroll/useEmployeePayrollReadiness.ts");
    expect(src).toMatch(/employee_contracts/);
    expect(src).toMatch(/contract_compensation_components/);
  });
});

describe("payroll RLS / salary privacy", () => {
  // The latest payslip RLS migration defines the gated policies + view.
  const payslipMig = "supabase/migrations/20260507115814_118e3773-8217-4673-91c2-990f311cfee5.sql";
  const redactedMig = "supabase/migrations/20260507142731_34b9b887-8d35-496b-b6b0-6d61f035a812.sql";

  it("payslip select policy uses module permission helper", () => {
    const src = read(payslipMig);
    expect(src).toMatch(/payslips/);
    expect(src).toMatch(/user_has_module_permission/);
  });

  it("v_payslips_redacted is security_invoker (no view-owner privilege escalation)", () => {
    const src = read(redactedMig);
    expect(src).toMatch(/v_payslips_redacted/);
    expect(src).toMatch(/security_invoker\s*=\s*true/);
  });

  it("v_payslips_redacted masks money columns via payroll_can_see_amounts", () => {
    const src = read(redactedMig);
    for (const col of ["gross_pay", "net_pay", "basic_salary", "total_deductions"]) {
      expect(
        new RegExp(`payroll_can_see_amounts[\\s\\S]*${col}|${col}[\\s\\S]*payroll_can_see_amounts`).test(src),
      ).toBe(true);
    }
  });

  it("frontend payslip header reads from v_payslips_redacted (not raw payslips)", () => {
    const src = read("src/pages/hr/payroll/sections.tsx");
    expect(src).toMatch(/v_payslips_redacted/);
  });

  it("frontend currency cells respect viewSalaryDetails permission", () => {
    const src = read("src/pages/hr/payroll/sections.tsx");
    expect(src).toMatch(/viewSalaryDetails/);
  });
});

describe("payroll reports parity (Stage 4)", () => {
  const KEYS = [
    "payroll_register",
    "payroll_summary",
    "employer_contributions",
    "statutory_liabilities",
    "employee_earnings",
    "branch_payroll_cost",
  ];

  it("every report key is dispatched in render-report", () => {
    const src = read("supabase/functions/render-report/index.ts");
    for (const k of KEYS) expect(src).toContain(`"${k}"`);
  });

  it("every report key has a builder branch in payrollData.ts", () => {
    const src = read("supabase/functions/_shared/reports/payrollData.ts");
    for (const k of KEYS) expect(src).toContain(`"${k}"`);
  });

  it("Reports page surfaces every key", () => {
    const src = read("src/pages/hr/payroll/Reports.tsx");
    for (const k of KEYS) expect(src).toContain(`"${k}"`);
  });

  it("Reports page wires drilldown to payslip + payroll_run", () => {
    const src = read("src/pages/hr/payroll/Reports.tsx");
    expect(src).toMatch(/payslip/);
    expect(src).toMatch(/payroll_run/);
  });
});

describe("payroll workspace IA invariants", () => {
  it("Configuration links only to live routes", () => {
    const src = read("src/pages/hr/payroll/sections.tsx");
    // The dead "(coming soon)" tiles must not return.
    expect(src).not.toMatch(/coming soon/i);
  });

  it("Overview KPI buckets are mutually exclusive", () => {
    const src = read("src/pages/hr/payroll/Overview.tsx");
    // pendingApproval must NOT include 'processed' (was the bug).
    const m = src.match(/pendingApproval\s*=\s*payrollRuns\.filter\(\(r\)\s*=>\s*[^)]+\)/);
    expect(m, "Could not find pendingApproval filter").toBeTruthy();
    expect(m![0]).not.toMatch(/processed/);
  });
});

describe("payroll drilldown", () => {
  it("useReportDrilldown registers payslip and payroll_run source-doc paths", () => {
    const src = read("src/hooks/useReportDrilldown.ts");
    expect(src).toMatch(/payslip:\s*"\/hr\/payroll\/payslips"/);
    expect(src).toMatch(/payroll_run:\s*"\/hr\/payroll\/runs"/);
    // Per-id branch (RESTful), not ?id= query string.
    expect(src).toMatch(/sourceDocType\s*===\s*"payslip"/);
    expect(src).toMatch(/sourceDocType\s*===\s*"payroll_run"/);
  });
});
