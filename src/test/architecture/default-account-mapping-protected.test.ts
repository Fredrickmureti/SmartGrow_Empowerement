import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — R3 of the COA re-audit.
 *
 * The `prevent_unmapped_system_role_delete` trigger on
 * `default_account_settings` blocks deletion of the last mapping for any
 * required system role. Without it, a stray DELETE silently breaks every
 * future invoice / bill posting.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("prevent_unmapped_system_role_delete trigger remains installed", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("no migration drops the trigger or its function", () => {
    const violations: string[] = [];
    // The R1 migration uses idempotent DROP TRIGGER IF EXISTS before
    // CREATE TRIGGER (same transaction). Skip its self-references.
    const RECREATE_ALLOWLIST = new Set<string>([
      "20260428181019_5c8f8cb4-db00-45fe-96d1-e1325d85103f.sql",
    ]);
    for (const file of files) {
      if (RECREATE_ALLOWLIST.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (
        /drop\s+trigger[^;]*prevent_unmapped_system_role_delete/i.test(sql) ||
        /drop\s+function[^;]*prevent_unmapped_system_role_delete/i.test(sql)
      ) {
        violations.push(file);
      }
    }
    expect(
      violations,
      `default_account_settings delete protection was weakened by:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the trigger function is still defined somewhere in migrations", () => {
    const found = files.some((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return /create\s+(or\s+replace\s+)?function\s+[\w.]*prevent_unmapped_system_role_delete/i.test(
        sql,
      );
    });
    expect(
      found,
      "prevent_unmapped_system_role_delete is no longer defined.",
    ).toBe(true);
  });
});
