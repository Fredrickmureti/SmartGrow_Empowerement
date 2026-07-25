/**
 * Architecture guard — payroll records loan repayment events; the loan
 * module owns loan state (ADR 0091 §9-§11).
 *
 * Fails if:
 *   1. the client state-machine mirror re-introduces the retired terminal
 *      status `settled` (rejected by `employee_loans_status_check`);
 *   2. the client mirror's `settle` event does not land on `completed`;
 *   3. the latest migration touching `process_payroll_loan_deductions`
 *      writes `employee_loans` directly instead of delegating to
 *      `employee_loan_apply_repayment`.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function rgFiles(pattern: string, path: string): string[] {
  try {
    return execSync(`rg -l ${JSON.stringify(pattern)} ${path}`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

describe("Payroll loan repayment — canonical lifecycle ownership", () => {
  it("client state machine has retired the 'settled' status", () => {
    const src = readFileSync("src/lib/hr/loanStateMachine.ts", "utf8");
    expect(src).not.toMatch(/"settled"/);
    expect(src).toMatch(/event: "settle", to: "completed"/);
    expect(src).toMatch(/TERMINAL_STATUSES[\s\S]*"completed"/);
  });

  it("payroll delegates repayment to the loan module (no direct loan writes)", () => {
    const files = rgFiles("process_payroll_loan_deductions", "supabase/migrations").sort();
    const latest = files[files.length - 1];
    expect(latest).toBeTruthy();
    const sql = readFileSync(latest, "utf8");
    // Isolate the function body of the most recent definition.
    const idx = sql.lastIndexOf("process_payroll_loan_deductions");
    const body = sql.slice(idx);
    expect(body).toMatch(/employee_loan_apply_repayment/);
    expect(body).not.toMatch(/UPDATE\s+public\.employee_loans/i);
    expect(body).not.toMatch(/'settled'/);
  });

  it("no edge function or client module writes employee_loans.status", () => {
    const files = [
      ...rgFiles("employee_loans", "supabase/functions"),
      ...rgFiles("employee_loans", "src"),
    ].filter(
      (f) =>
        !f.startsWith("src/test/") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test.tsx") &&
        f !== "src/integrations/supabase/types.ts",
    );
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /from\(\s*["']employee_loans["']\s*\)[\s\S]{0,200}?\.update\(\s*\{[^}]*status\s*:/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("the canonical repayment RPC exists and drives completion through the state machine", () => {
    const files = rgFiles("employee_loan_apply_repayment", "supabase/migrations").sort();
    const latest = files[files.length - 1];
    expect(latest).toBeTruthy();
    const sql = readFileSync(latest, "utf8");
    expect(sql).toMatch(/employee_loan_settle/);
    expect(sql).toMatch(/loan_log_event/);
    expect(sql).toMatch(/already_applied/);
    // Audit parity: the amount + source references travel with the event.
    expect(sql).toMatch(/'repayment_recorded',\s*prior,\s*prior,\s*\n?\s*_amount/);
    expect(sql).toMatch(/'payroll_run_id'/);
  });
});
