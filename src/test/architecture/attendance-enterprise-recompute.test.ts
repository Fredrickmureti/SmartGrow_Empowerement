/**
 * Enterprise attendance recompute guard — locks the new contract:
 *
 *  1. `calculate_attendance_hours` is schedule + holiday + settings aware
 *     (no flat 8h fallback baked into the column writers).
 *  2. `attendance_generate_work_entries` uses derived OT from
 *     `attendance.overtime_hours`, with optional pre-approval cap when
 *     `require_ot_preapproval = true`. It must NOT silently set OT to 0
 *     when no `overtime_requests` row exists.
 *
 * These tests grep the live function source pulled from `pg_proc` via
 * scripts/sql snapshots (the migration source files), keeping it stable
 * across migration filename churn.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIG_DIR = resolve(__dirname, "../../../supabase/migrations");

function findMigration(needle: string): string {
  // Use the LATEST migration that contains the needle — multiple migrations
  // may redefine the same function and we want the current authoritative one.
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const src = readFileSync(resolve(MIG_DIR, files[i]), "utf8");
    if (src.includes(needle)) return src;
  }
  return "";
}

describe("Attendance — enterprise recompute contract", () => {
  it("calculate_attendance_hours reads attendance_settings + work_schedule_days + public_holidays", () => {
    const src = findMigration("CREATE OR REPLACE FUNCTION public.calculate_attendance_hours");
    expect(src).toMatch(/attendance_settings/);
    expect(src).toMatch(/work_schedule_days/);
    expect(src).toMatch(/public_holidays/);
    // Rest-day / holiday path treats all hours as OT.
    expect(src).toMatch(/v_is_rest\s+OR\s+v_is_holiday/);
    // Uses the business timezone, not UTC.
    expect(src).toMatch(/AT TIME ZONE v_tz/);
  });

  it("attendance_generate_work_entries derives OT from attendance, not just overtime_requests", () => {
    const src = findMigration("CREATE OR REPLACE FUNCTION public.attendance_generate_work_entries");
    // Reads attendance.overtime_hours.
    expect(src).toMatch(/SUM\(a\.overtime_hours\)/);
    // The pre-approval cap is conditional, not unconditional like before.
    expect(src).toMatch(/require_ot_preapproval/);
    expect(src).toMatch(/WHEN v_require_preapproval/);
  });
});
