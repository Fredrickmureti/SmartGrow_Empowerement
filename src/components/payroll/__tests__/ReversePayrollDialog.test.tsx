/**
 * Static-source guard for the Reverse Payroll flow.
 *
 * The full dialog is heavy on providers (auth/org/business/currency/query
 * client) — rather than spin all of them up, this test pins the wire-level
 * contracts the audit committed to: which edge function each scope hits,
 * the negated-earnings shape, the cascade-invalidation set, and the
 * minimum-reason gate.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../ReversePayrollDialog.tsx"),
  "utf8",
);
const RUNS = fs.readFileSync(
  path.resolve(__dirname, "../../../pages/hr/payroll/Runs.tsx"),
  "utf8",
);

describe("ReversePayrollDialog wire contract", () => {
  it("invokes reverse-payroll for whole-run scope", () => {
    expect(SRC).toMatch(/supabase\.functions\.invoke\(\s*["']reverse-payroll["']/);
  });

  it("invokes compute-payroll with run_type='correction' for selected employees", () => {
    expect(SRC).toMatch(/supabase\.functions\.invoke\(\s*["']compute-payroll["']/);
    expect(SRC).toMatch(/run_type:\s*["']correction["']/);
    expect(SRC).toMatch(/parent_run_id/);
  });

  it("negates gross_pay when building correction variable_earnings", () => {
    expect(SRC).toMatch(/amount:\s*-ps\.gross_pay/);
  });

  it("requires reason >= 10 chars before submit is enabled", () => {
    expect(SRC).toMatch(/reason\.trim\(\)\.length\s*>=\s*10/);
  });

  it("cascade-invalidates dependent React Query caches on success", () => {
    for (const key of [
      "payroll-runs",
      "payroll-liabilities",
      "payroll-return-runs",
      "journal-entries",
      "payroll-payments",
      "payroll-run-issues",
      "payslip-lines",
    ]) {
      expect(SRC).toContain(`"${key}"`);
    }
  });

  it("loads its preview from the payroll_run_reversal_preview RPC", () => {
    expect(SRC).toMatch(/payroll_run_reversal_preview/);
  });
});

describe("ReversePayrollDialog is wired into the Runs page", () => {
  it("Runs.tsx imports and renders ReversePayrollDialog", () => {
    expect(RUNS).toMatch(/from\s+"@\/components\/payroll\/ReversePayrollDialog"/);
    expect(RUNS).toMatch(/<ReversePayrollDialog/);
  });

  it("passes onReverse to both PayrollRunList and PayrollRunDetailsDialog", () => {
    const list = RUNS.slice(RUNS.indexOf("<PayrollRunList"), RUNS.indexOf("/>", RUNS.indexOf("<PayrollRunList")));
    const dlg = RUNS.slice(RUNS.indexOf("<PayrollRunDetailsDialog"), RUNS.indexOf("/>", RUNS.indexOf("<PayrollRunDetailsDialog")));
    expect(list).toMatch(/onReverse=/);
    expect(dlg).toMatch(/onReverse=/);
  });
});