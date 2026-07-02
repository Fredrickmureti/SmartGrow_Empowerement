/**
 * Architecture guard — Wave-3 payroll mapping trigger.
 *
 * Wave-3 closed a bypass where Finance → Default Accounts was upserting
 * payroll keys directly via PostgREST, skipping the RPC-level role guard.
 * The fix installed a BEFORE INSERT/UPDATE trigger on
 * `default_account_settings` calling `_payroll_assert_mapping_role`. This
 * test scans migrations and fails if:
 *
 *   - The trigger / its function disappears from the latest defining
 *     migration.
 *   - A later migration drops the trigger or function (allowlist = the
 *     creating migration, which uses idempotent DROP TRIGGER IF EXISTS
 *     before CREATE TRIGGER in the same transaction).
 *
 * See: docs/adr/0022-payroll-mapping-integrity.md
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const TRIGGER_NAME = "trg_default_account_settings_payroll_role";
const FUNCTION_NAME = "_payroll_default_account_role_trigger";
const ASSERT_FUNCTION = "_payroll_assert_mapping_role";

// The Wave-3 migration that originally creates the trigger. Idempotent
// DROP TRIGGER IF EXISTS / DROP FUNCTION IF EXISTS inside this file is
// expected and allowed.
const CREATING_MIGRATION = "20260525172513_ea9fd5b3-13ec-456c-9954-1c450fa08d55.sql";

describe("Wave-3 — default_account_settings payroll role trigger", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("creates the BEFORE INSERT OR UPDATE trigger on default_account_settings", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, CREATING_MIGRATION), "utf8");
    expect(sql).toMatch(
      new RegExp(
        `CREATE\\s+TRIGGER\\s+${TRIGGER_NAME}[\\s\\S]*?BEFORE\\s+INSERT\\s+OR\\s+UPDATE[\\s\\S]*?ON\\s+public\\.default_account_settings[\\s\\S]*?EXECUTE\\s+FUNCTION\\s+public\\.${FUNCTION_NAME}`,
        "i",
      ),
    );
  });

  it("the trigger function calls _payroll_assert_mapping_role", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, CREATING_MIGRATION), "utf8");
    expect(sql).toMatch(
      new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${FUNCTION_NAME}[\\s\\S]*?${ASSERT_FUNCTION}`,
        "i",
      ),
    );
  });

  it("no later migration drops the trigger or its function", () => {
    const violations: string[] = [];
    for (const file of files) {
      if (file === CREATING_MIGRATION) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (
        new RegExp(`drop\\s+trigger[^;]*${TRIGGER_NAME}`, "i").test(sql) ||
        new RegExp(`drop\\s+function[^;]*${FUNCTION_NAME}`, "i").test(sql)
      ) {
        violations.push(file);
      }
    }
    expect(
      violations,
      `Wave-3 payroll mapping trigger was weakened by:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
