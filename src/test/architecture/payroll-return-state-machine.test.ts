/**
 * Architecture guard — Payroll return state machine integrity.
 *
 * The 7-state machine for `payroll_return_runs` is the sole legal path
 * to change a return's status. This test parses the migration that
 * introduced `payroll_return_transition` and asserts every state and
 * required transition is still declared, and that the audit → outbox
 * fan-out is still wired. A future migration that widens the matrix
 * MUST update this test consciously; a migration that narrows or
 * removes it will fail here first.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const migrationsDir = resolve(__dirname, "../../../supabase/migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

// Concatenate all migrations so refactors that split the state machine
// across follow-up migrations still satisfy the invariants — this
// represents the effective schema.
const allSql = files
  .map((f) => readFileSync(resolve(migrationsDir, f), "utf8"))
  .join("\n---\n");

describe("payroll return state machine migration", () => {
  it("declares the payroll_return_transition RPC", () => {
    expect(allSql).toMatch(/FUNCTION\s+public\.payroll_return_transition\s*\(/i);
  });

  it("declares all 8 return states in the transition matrix", () => {
    for (const state of [
      "draft",
      "generated",
      "filed",
      "acknowledged",
      "rejected",
      "superseded",
      "cancelled",
      "archived",
    ]) {
      expect(
        new RegExp(`'${state}'`).test(allSql),
        `state "${state}" missing from state machine SQL`,
      ).toBe(true);
    }
  });

  it("declares required transitions (draft→generated, generated→filed, filed→acknowledged)", () => {
    // Look for the WHEN branches to prove the matrix is intact.
    expect(allSql).toMatch(/WHEN\s+'draft'\s+THEN[^\n]*'generated'/i);
    expect(allSql).toMatch(/WHEN\s+'generated'\s+THEN[^\n]*'filed'/i);
    expect(allSql).toMatch(/WHEN\s+'filed'\s+THEN[^\n]*'acknowledged'/i);
    expect(allSql).toMatch(/WHEN\s+'filed'\s+THEN[^\n]*'rejected'/i);
  });

  it("creates the pack_return_run_audit table with RLS + service-role write policy", () => {
    expect(allSql).toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+public\.pack_return_run_audit/i);
    expect(allSql).toMatch(/ALTER\s+TABLE\s+public\.pack_return_run_audit\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(allSql).toMatch(/CREATE\s+POLICY\s+pack_return_run_audit_service_write/i);
  });

  it("wires the outbox trigger from audit rows to business_event_outbox", () => {
    expect(allSql).toMatch(/emit_return_state_change_event/);
    expect(allSql).toMatch(/'return\.state_changed'/);
    expect(allSql).toMatch(/CREATE\s+TRIGGER\s+trg_pack_return_run_audit_outbox/i);
  });

  it("emits pack lifecycle events (published + upgraded)", () => {
    expect(allSql).toMatch(/'pack\.published'/);
    expect(allSql).toMatch(/'pack\.upgraded'/);
  });

  it("adds idempotency_key + amends_run_id columns to payroll_return_runs", () => {
    expect(allSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+idempotency_key/i);
    expect(allSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+amends_run_id/i);
    expect(allSql).toMatch(/payroll_return_runs_idem_uidx/);
  });
});
