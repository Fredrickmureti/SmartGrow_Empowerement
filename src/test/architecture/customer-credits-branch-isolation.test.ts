import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 4 (Customer Credits) regression net.
 *
 * Asserts the hardened `apply_credit_to_invoice_atomic` migration:
 *   - exists,
 *   - cross-checks business_id between credit_note + invoice,
 *   - blocks cross-branch application,
 *   - stamps both JE header AND every JE line with branch_id,
 *   - stamps `credit_note_applications.branch_id` on insert.
 */
const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("Customer Credits — branch isolation invariants", () => {
  const sqlByFile = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const hardened = sqlByFile.find(
    ({ sql }) =>
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.apply_credit_to_invoice_atomic/i.test(sql) &&
      /Cross-branch credit application/i.test(sql),
  );

  it("hardened apply_credit_to_invoice_atomic migration exists", () => {
    expect(hardened, "Phase 4 hardening migration is missing").toBeDefined();
  });

  it("rejects cross-business application", () => {
    expect(hardened?.sql).toMatch(/Credit note business mismatch/i);
    expect(hardened?.sql).toMatch(/Invoice business mismatch/i);
    expect(hardened?.sql).toMatch(/Cross-business credit application is not allowed/i);
  });

  it("rejects cross-branch application", () => {
    expect(hardened?.sql).toMatch(/Cross-branch credit application is not allowed/i);
  });

  it("stamps branch_id on JE header AND on both JE lines", () => {
    const sql = hardened!.sql;
    // Header insert includes branch_id column
    expect(sql).toMatch(/INSERT\s+INTO\s+journal_entries[\s\S]*?branch_id[\s\S]*?VALUES/i);
    // Both line inserts include branch_id and pass v_target_branch
    const lineInserts = sql.match(/INSERT\s+INTO\s+journal_entry_lines[\s\S]*?v_target_branch\)/gi) ?? [];
    expect(lineInserts.length).toBeGreaterThanOrEqual(2);
  });

  it("stamps credit_note_applications row with business_id + branch_id", () => {
    expect(hardened?.sql).toMatch(
      /INSERT\s+INTO\s+credit_note_applications[\s\S]*?business_id,\s*branch_id/i,
    );
  });

  it("credit_note_applications has branch-aware SELECT + INSERT policies", () => {
    const policyMig = sqlByFile.find(({ sql }) =>
      /View credit applications \(branch-aware\)/i.test(sql),
    );
    expect(policyMig, "Branch-aware RLS policies missing").toBeDefined();
    expect(policyMig?.sql).toMatch(/user_can_access_branch/);
    expect(policyMig?.sql).toMatch(/has_finance_permission/);
  });
});
