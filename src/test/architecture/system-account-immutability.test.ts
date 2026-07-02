import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — Phase E of the COA zero-trust audit.
 *
 * System accounts (`is_system = true`) and accounts with posted journal
 * entries must be immutable. The DB enforces this via the
 * `enforce_account_lifecycle` trigger created in migration
 * `20260428175344_*`. This test makes sure that trigger is never silently
 * dropped or disabled by a later migration.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("enforce_account_lifecycle trigger remains installed", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Migrations that legitimately DROP and immediately re-CREATE the
  // function in the same transaction (idempotent install pattern).
  const RECREATE_ALLOWLIST = new Set<string>([
    "20260428175148_06ab9cb1-bd33-4fc4-b291-308bd0848fb8.sql",
  ]);

  it("no migration drops or disables enforce_account_lifecycle", () => {
    const violations: string[] = [];

    for (const file of files) {
      if (RECREATE_ALLOWLIST.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").toLowerCase();

      // Drop trigger / drop function on the lifecycle guard
      if (
        /drop\s+trigger[^;]*enforce_account_lifecycle/i.test(sql) ||
        /drop\s+function[^;]*enforce_account_lifecycle/i.test(sql)
      ) {
        violations.push(`${file}: drops enforce_account_lifecycle`);
      }

      // Disabling the trigger
      if (
        /alter\s+table[^;]*disable\s+trigger\s+enforce_account_lifecycle/i.test(
          sql,
        )
      ) {
        violations.push(`${file}: disables enforce_account_lifecycle`);
      }
    }

    expect(
      violations,
      `Account lifecycle protection was weakened by:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the lifecycle trigger function is still defined somewhere", () => {
    const found = files.some((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return /create\s+(or\s+replace\s+)?function\s+[\w.]*enforce_account_lifecycle/i.test(
        sql,
      );
    });

    expect(
      found,
      "Could not find a CREATE FUNCTION enforce_account_lifecycle in any migration. " +
        "System-account immutability is no longer protected at the DB layer.",
    ).toBe(true);
  });
});
