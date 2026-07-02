/**
 * HR production-readiness audit — Wave 2 + Wave 4 guards.
 *
 * - Wave 2: accept-invitation MUST surface employee-link outcome through
 *   `record_invitation_link_outcome` so silent unlinked accepts cannot
 *   re-appear.
 * - Wave 4: timesheet_submissions state machine migration MUST exist and
 *   declare the trigger function name we depend on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = "supabase/migrations";

function findMigrationContaining(needle: string): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));
  for (const f of files) {
    const src = readFileSync(join(MIG_DIR, f), "utf8");
    if (src.includes(needle)) return src;
  }
  throw new Error(`No migration contains '${needle}'`);
}

describe("HR audit Wave 2 — invitation link outcome is surfaced", () => {
  const fn = readFileSync(
    "supabase/functions/accept-invitation/index.ts",
    "utf8",
  );

  it("delegates accept to the atomic RPC", () => {
    expect(fn).toMatch(/accept_organization_invitation_atomic/);
    expect(fn).toMatch(/p_invitation_id:\s*invitation\.id/);
    expect(fn).toMatch(/p_user_id:\s*finalUserId/);
  });

  it("surfaces would_demote_admin from the RPC", () => {
    expect(fn).toMatch(/would_demote_admin/);
  });

  it("reads employee_linked / linked_employee_id from the RPC result", () => {
    expect(fn).toMatch(/employee_linked/);
    expect(fn).toMatch(/linked_employee_id/);
  });

  it("record_invitation_link_outcome and onboarding_attempts unique index exist", () => {
    const src = findMigrationContaining("record_invitation_link_outcome");
    expect(src).toMatch(
      /CREATE OR REPLACE FUNCTION public\.record_invitation_link_outcome/,
    );
    expect(src).toMatch(/onboarding_attempts_idempotency_key_uniq/);
  });

  it("atomic accept function exists and calls record_invitation_link_outcome", () => {
    const src = findMigrationContaining(
      "accept_organization_invitation_atomic",
    );
    expect(src).toMatch(
      /CREATE OR REPLACE FUNCTION public\.accept_organization_invitation_atomic/,
    );
    expect(src).toMatch(/PERFORM record_invitation_link_outcome/);
    expect(src).toMatch(/would_demote_admin/);
  });
});

describe("HR audit Wave 5 — payroll readiness severity override", () => {
  it("payroll_readiness_rule_overrides table + blockers override exist", () => {
    const src = findMigrationContaining("payroll_readiness_rule_overrides");
    expect(src).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.payroll_readiness_rule_overrides/,
    );
    expect(src).toMatch(/COALESCE\(o\.severity, r\.severity\)\s*=\s*'block'/);
  });
});

describe("HR audit Wave — failed onboarding visibility", () => {
  it("hr_list_failed_onboarding_attempts RPC exists", () => {
    const src = findMigrationContaining("hr_list_failed_onboarding_attempts");
    expect(src).toMatch(
      /CREATE OR REPLACE FUNCTION public\.hr_list_failed_onboarding_attempts/,
    );
  });

  it("HR ops route is mounted under /hr/onboarding-issues", () => {
    const routes = readFileSync(
      "src/apps/hr/sub/EmployeesRoutes.tsx",
      "utf8",
    );
    expect(routes).toMatch(/path="onboarding-issues"/);
    expect(routes).toMatch(/OnboardingIssues/);
  });
});

describe("HR audit Wave 4 — timesheet submission state machine", () => {
  const src = findMigrationContaining(
    "tg_timesheet_submission_state_machine",
  );

  it("installs the CHECK constraint with the canonical status set", () => {
    expect(src).toMatch(/timesheet_submissions_status_check/);
    for (const s of ["draft", "submitted", "approved", "rejected", "locked"]) {
      expect(src).toMatch(new RegExp(`'${s}'`));
    }
  });

  it("installs the BEFORE UPDATE OF status trigger", () => {
    expect(src).toMatch(/trg_timesheet_submission_state_machine/);
    expect(src).toMatch(/BEFORE INSERT OR UPDATE OF status/);
  });

  it("treats locked as terminal", () => {
    expect(src).toMatch(/Cannot transition out of locked/i);
  });

  it("rejects illegal transitions via plain SQL", () => {
    expect(src).toMatch(/Illegal timesheet status transition/);
  });
});
