/**
 * R2 architecture guard — payroll audit trail must be installed.
 *
 * The audit trigger lives in a single migration (R2). Static-analysis
 * guard so a future migration that drops or renames the trigger fails CI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = "supabase/migrations";

function findR2Migration(): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));
  for (const f of files) {
    const src = readFileSync(join(MIG_DIR, f), "utf8");
    if (src.includes("log_payroll_audit") && src.includes("payroll_run_validate_schedule")) {
      return src;
    }
  }
  throw new Error("R2 migration not found (log_payroll_audit + payroll_run_validate_schedule).");
}

describe("R2 — payroll audit trail + pay_schedule FK", () => {
  const src = findR2Migration();

  it("adds nullable pay_schedule_id FK on payroll_runs", () => {
    expect(src).toMatch(/payroll_runs[\s\S]*pay_schedule_id[\s\S]*REFERENCES\s+public\.pay_schedules/i);
  });

  it("installs validation trigger on payroll_runs", () => {
    expect(src).toMatch(/trg_payroll_run_validate_schedule/);
    expect(src).toMatch(/payment_offset_days/);
  });

  it("installs audit trigger on every payroll write surface", () => {
    for (const trg of [
      "trg_audit_payroll_run_insert",
      "trg_audit_payroll_run_update",
      "trg_audit_payslip_update",
      "trg_audit_payroll_liability_update",
      "trg_audit_remittance_payment_insert",
      "trg_audit_remittance_payment_update",
    ]) {
      expect(src).toContain(trg);
    }
  });

  it("audit logger uses the existing audit_logs.action enum (create/update only)", () => {
    // Must not invent new action verbs the CHECK constraint would reject.
    const fnBody = src.match(/CREATE OR REPLACE FUNCTION public\.log_payroll_audit[\s\S]*?\$\$;/)![0];
    expect(fnBody).toMatch(/'create'/);
    expect(fnBody).toMatch(/'update'/);
    expect(fnBody).not.toMatch(/'(approve|post|reverse|pay)'/);
  });

  it("audit logger writes only status-relevant subset jsonb (not full row)", () => {
    const fnBody = src.match(/CREATE OR REPLACE FUNCTION public\.log_payroll_audit[\s\S]*?\$\$;/)![0];
    // Sanity: must not pass row_to_json/to_jsonb of the whole record.
    expect(fnBody).not.toMatch(/to_jsonb\(NEW\)/);
    expect(fnBody).not.toMatch(/row_to_json\(NEW\)/);
  });
});
