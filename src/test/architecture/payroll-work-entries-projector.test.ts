/**
 * Architectural guard for ADR-0042: payroll_work_entries has exactly
 * one writer (the projector RPC `payroll_work_entries_project`).
 *
 *  1. The compute-payroll edge function must NOT directly insert into
 *     `payroll_work_entries`; it must call the projector RPC instead.
 *  2. The client hook must invoke `payroll_work_entries_project`, not
 *     the legacy `attendance_generate_work_entries`.
 *  3. The ADR file documenting the decision exists.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("Payroll Work Entries — single projector (ADR-0042)", () => {
  it("compute-payroll does NOT insert directly into payroll_work_entries", () => {
    const src = read("supabase/functions/compute-payroll/index.ts");
    expect(src).not.toMatch(/\.from\(\s*["']payroll_work_entries["']\s*\)\s*\.\s*insert/);
  });

  it("compute-payroll invokes the projector RPC", () => {
    const src = read("supabase/functions/compute-payroll/index.ts");
    expect(src).toMatch(/rpc\(\s*["']payroll_work_entries_project["']/);
  });

  it("client hook calls payroll_work_entries_project", () => {
    const src = read("src/hooks/payroll/useGenerateAttendanceWorkEntries.ts");
    expect(src).toMatch(/payroll_work_entries_project/);
  });

  it("ADR-0042 file exists", () => {
    expect(existsSync(resolve(ROOT, "docs/adr/0042-payroll-work-entries-single-projector.md"))).toBe(true);
  });
});
