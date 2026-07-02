/**
 * Portal payslip visibility contract
 * ----------------------------------
 * Locks the architectural invariants behind the "Employee Self-Service
 * Portal Deep Investigation" fix:
 *
 *   1. A single security-definer helper (`payslip_visible_to_employee`)
 *      decides whether an authenticated employee may read a payslip.
 *   2. `payslip_lines_self_select`, the self-branch of
 *      `payslips_select_branch_scoped`, and the new
 *      `payroll_runs_self_select` all key off that helper / the same
 *      finalized status set — so the portal cannot end up with an
 *      "I can see the summary but no lines" inconsistency again.
 *   3. The `/me/payslips` surface uses the shared `ReportExportButtons`
 *      with `hideEmail` set — payslip PII must never gain an
 *      "Email Report…" affordance from an employee surface.
 *   4. No `/me/*` page imports `EmailReportDialog` directly to back-door it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();

function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf8");
}

function findMigrationsContaining(needle: string): string[] {
  const dir = join(ROOT, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  return files.filter((f) => readFileSync(join(dir, f), "utf8").includes(needle));
}

describe("portal payslip visibility contract", () => {
  it("ships the payslip_visible_to_employee security-definer helper", () => {
    const hits = findMigrationsContaining("payslip_visible_to_employee");
    expect(hits.length).toBeGreaterThan(0);

    const body = readFileSync(
      join(ROOT, "supabase/migrations", hits[hits.length - 1]),
      "utf8",
    );
    expect(body).toMatch(/CREATE OR REPLACE FUNCTION public\.payslip_visible_to_employee/);
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path = public/);
    // Enterprise rule (Workday/ADP/BambooHR/Odoo): payslip visibility is
    // gated on the parent payroll_run's approval/posting state, NOT on
    // payslips.status (which only tracks payment: pending -> paid).
    expect(body).toMatch(/payroll_runs/);
    expect(body).toMatch(/'approved'\s*,\s*'posted'\s*,\s*'closed'\s*,\s*'paid'/);
  });

  function findPolicyDefiningMigration(policyName: string): string {
    const hits = findMigrationsContaining(`CREATE POLICY ${policyName}`);
    expect(hits.length, `no migration creates ${policyName}`).toBeGreaterThan(0);
    return readFileSync(
      join(ROOT, "supabase/migrations", hits[hits.length - 1]),
      "utf8",
    );
  }

  it("payslip_lines_self_select delegates to the helper", () => {
    const body = findPolicyDefiningMigration("payslip_lines_self_select");
    expect(body).toMatch(
      /CREATE POLICY payslip_lines_self_select[\s\S]*payslip_visible_to_employee\(payslip_id\)/,
    );
  });

  it("payroll_runs_self_select policy exists and only opens runs with a visible payslip", () => {
    const body = findPolicyDefiningMigration("payroll_runs_self_select");
    expect(body).toMatch(/CREATE POLICY payroll_runs_self_select[\s\S]*payslip_visible_to_employee/);
  });


  it("payslips self-select branch gates on payroll_run status, not payslip status", () => {
    const hits = findMigrationsContaining("payslips_select_branch_scoped");
    expect(hits.length).toBeGreaterThan(0);
    const latest = readFileSync(
      join(ROOT, "supabase/migrations", hits[hits.length - 1]),
      "utf8",
    );
    const policy = latest.split(/CREATE POLICY payslips_select_branch_scoped/).pop()!;
    // The self branch must reach payroll_runs (approval lifecycle) and
    // accept the finalized run statuses.
    expect(policy).toMatch(/payroll_runs/);
    expect(policy).toMatch(/'approved'\s*,\s*'posted'\s*,\s*'closed'\s*,\s*'paid'/);
  });


  it("every portal surface that uses ReportExportButtons sets hideEmail", () => {
    // All employee self-service pages live under /me/* or are mounted by
    // MeApp (e.g. MyTimesheets). Sending payroll/timesheet PII to arbitrary
    // recipients is an admin-only capability.
    const PORTAL_FILES = [
      "src/pages/me/MyPayslips.tsx",
      "src/pages/timesheets/MyTimesheets.tsx",
    ];
    for (const f of PORTAL_FILES) {
      const src = read(f);
      if (!/ReportExportButtons/.test(src)) continue;
      expect(src, `${f} must pass hideEmail to ReportExportButtons`).toMatch(
        /<ReportExportButtons[^>]*hideEmail/,
      );
    }
  });

  it("no /me/* page imports EmailReportDialog directly", () => {
    const meDir = join(ROOT, "src/pages/me");
    for (const f of readdirSync(meDir).filter((x) => x.endsWith(".tsx"))) {
      const body = readFileSync(join(meDir, f), "utf8");
      expect(
        body,
        `${f} must not import EmailReportDialog (admin-only affordance)`,
      ).not.toMatch(/EmailReportDialog/);
    }
  });
});
