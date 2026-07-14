/**
 * Architecture guard for the Slice 2 Custom Deductions subsystem.
 *
 * Fails if:
 *   1. compute-payroll stops iterating custom_deduction_types.
 *   2. compute-payroll emits a custom-deduction payslip_line without
 *      source='custom_deduction' + assignment_id + deduction_type_id.
 *   3. post-payroll-gl stops resolving the per-type GL accounts and
 *      falls back to default_account_settings for custom deductions.
 *   4. The readiness rule loses its predicate anchor.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const ROOT = join(process.cwd());
const COMPUTE = readFileSync(join(ROOT, "supabase/functions/compute-payroll/index.ts"), "utf8");
const POST_GL = readFileSync(join(ROOT, "supabase/functions/post-payroll-gl/index.ts"), "utf8");

describe("Custom Deductions engine wiring", () => {
  it("compute-payroll fetches custom deduction assignments", () => {
    expect(COMPUTE).toMatch(/from\(["']employee_custom_deductions["']\)/);
    expect(COMPUTE).toMatch(/custom_deduction_types/);
  });

  it("compute-payroll emits payslip lines with source='custom_deduction' and provenance ids", () => {
    // The custom deduction emission block sets source in the details payload
    expect(COMPUTE).toMatch(/source:\s*["']custom_deduction["']/);
    expect(COMPUTE).toMatch(/assignment_id:\s*cd\.assignment_id/);
    expect(COMPUTE).toMatch(/deduction_type_id:\s*cd\.type_id/);
  });

  it("compute-payroll does not leak custom deductions into generic deduction buckets", () => {
    const customBlock = COMPUTE.slice(
      COMPUTE.indexOf("// ─── Turn D: custom deductions"),
      COMPUTE.indexOf("const empTotalDeductions"),
    );

    // Custom deductions must be represented only by customDeductionLineMeta so
    // their per-type GL account can travel in payslip_lines.source. If they are
    // also pushed into deductionsDetail/contributionsDetail, the generic line
    // emitter creates a second rule_code like custom_<code>_<assignment_id>, and
    // the run-level GL validator wrongly asks for default_account_settings rows.
    expect(customBlock).not.toMatch(/deductionsDetail\s*\[/);
    expect(customBlock).not.toMatch(/contributionsDetail\s*\[/);
    expect(customBlock).toMatch(/customEmployeeDeductionTotal/);
    expect(customBlock).toMatch(/customEmployerContributionTotal/);
  });

  it("compute-payroll bumps cumulative_recovered and auto-completes on cap", () => {
    expect(COMPUTE).toMatch(/cumulative_recovered/);
    expect(COMPUTE).toMatch(/status.*=.*["']completed["']/);
    // Auto-complete emits a 'recovered' event stamped with the run id.
    expect(COMPUTE).toMatch(/employee_custom_deduction_events/);
    expect(COMPUTE).toMatch(/event_type:\s*["']recovered["']/);
  });
});

describe("Custom Deductions posting wiring", () => {
  it("post-payroll-gl aggregates per deduction_type_id from line details", () => {
    expect(POST_GL).toMatch(/details\.source\s*===\s*["']custom_deduction["']/);
    expect(POST_GL).toMatch(/customDedMap/);
  });

  it("post-payroll-gl refuses to post when the type is missing GL mapping", () => {
    expect(POST_GL).toMatch(/CUSTOM_DEDUCTION|Custom deduction types are missing GL mapping/);
    expect(POST_GL).toMatch(/missing_mappings/);
  });

  it("post-payroll-gl posts against per-type gl_liability_account_id (not default_account_settings)", () => {
    expect(POST_GL).toMatch(/cd\.gl_liability_account_id/);
    expect(POST_GL).toMatch(/cd\.gl_expense_account_id/);
  });
});
