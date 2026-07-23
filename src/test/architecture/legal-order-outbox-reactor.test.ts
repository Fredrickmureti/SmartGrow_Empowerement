/**
 * Guard: the DB trigger that reacts to legal_order.* outbox events must
 * remain installed. Without it, activating / suspending / releasing a
 * garnishment leaves already-computed draft payroll runs stale and the
 * generated payslip silently omits the deduction (the incident that
 * motivated ADR-style reactor described in
 * docs/audit/2026-06-06-hr-payroll-reaudit-v2.md).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

function allMigrationSql(): string {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
    .join("\n");
}

describe("legal_order → payroll reactor", () => {
  const sql = allMigrationSql();

  it("declares the reactor trigger function", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.tg_business_event_outbox_react_legal_order/i,
    );
  });

  it("attaches an AFTER INSERT trigger scoped to legal_order.* events", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER\s+trg_business_event_outbox_react_legal_order[\s\S]{0,400}legal_order\.%/i,
    );
  });

  it("stamps draft runs with needs_recompute_reason", () => {
    expect(sql).toMatch(/needs_recompute_reason/);
    expect(sql).toMatch(/status IN \('draft','pending_approval'\)/);
  });

  it("does NOT mutate posted/paid/reversed runs (immutability preserved)", () => {
    // Reactor writes to audit_logs for finalized runs instead of UPDATEing them.
    expect(sql).toMatch(
      /INSERT INTO public\.audit_logs[\s\S]{0,600}payroll\.legal_order\.affects_finalized_run/,
    );
  });
});
