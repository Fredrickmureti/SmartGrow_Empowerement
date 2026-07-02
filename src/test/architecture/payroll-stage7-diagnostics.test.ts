/**
 * Stage 7 (engine) + Stage 8 (diagnostics) static guards.
 *
 * Live engine behaviour requires a Postgres + edge runtime. We pin the
 * critical contracts as static-analysis guards so a refactor cannot
 * silently regress the timesheet-approval gate or the diagnostics view.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(p, "utf8");

describe("payroll Stage 7 — timesheet approval gate", () => {
  const engine = read("supabase/functions/compute-payroll/index.ts");

  it("engine queries timesheets table within the pay period", () => {
    expect(engine).toMatch(/from\("timesheets"\)/);
    expect(engine).toMatch(/time_tracking_source.*timesheets/);
  });

  it("engine emits TIMESHEETS_NOT_APPROVED / TIMESHEETS_MISSING blocker codes", () => {
    expect(engine).toMatch(/TIMESHEETS_NOT_APPROVED/);
    expect(engine).toMatch(/TIMESHEETS_MISSING/);
  });

  it("engine inserts blocker rows into payroll_run_issues for skipped employees", () => {
    // Look for severity=blocker insert path.
    expect(engine).toMatch(/severity:\s*"blocker"/);
    expect(engine).toMatch(/skippedEmployees/);
  });

  it("engine skips compute loop for gated employees (continue)", () => {
    expect(engine).toMatch(/skippedEmployees\.has\(emp\.id\)/);
  });
});

describe("payroll Stage 8 — diagnostics view", () => {
  it("payroll_diagnostics view exists in a migration and is security_invoker", () => {
    const dir = "supabase/migrations";
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    const hit = files.find((f) => /payroll_diagnostics/.test(read(join(dir, f))));
    expect(hit, "no migration creates payroll_diagnostics view").toBeTruthy();
    const src = read(join(dir, hit!));
    expect(src).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.payroll_diagnostics/i);
    expect(src).toMatch(/security_invoker\s*=\s*true/);
  });

  it("PayrollRunDetailsDialog reads diagnostics through the view", () => {
    const src = read("src/components/payroll/PayrollRunDetailsDialog.tsx");
    expect(src).toMatch(/from\("payroll_diagnostics" as any\)/);
    expect(src).toMatch(/employee_first_name/);
  });
});
