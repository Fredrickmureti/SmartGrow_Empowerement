import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — R4 of the COA re-audit.
 *
 * `repair_legacy_statutory_accounts(_organization_id uuid)` is the
 * idempotent SECURITY DEFINER function that cleans up old NHIF / PAYE /
 * NSSF / SDL / etc. accounts on existing orgs. Every change is recorded
 * in account_change_audit_log.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("repair_legacy_statutory_accounts function remains defined", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("no migration drops the repair function", () => {
    const violations: string[] = [];
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (/drop\s+function[^;]*repair_legacy_statutory_accounts/i.test(sql)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the function is created in migration history", () => {
    const found = files.some((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return /create\s+(or\s+replace\s+)?function\s+[\w.]*repair_legacy_statutory_accounts/i.test(
        sql,
      );
    });
    expect(
      found,
      "repair_legacy_statutory_accounts is missing — legacy COA cleanup will require hand-run SQL.",
    ).toBe(true);
  });

  it("the function writes to account_change_audit_log (audit trail required)", () => {
    const fileWithDef = files.find((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return /create\s+(or\s+replace\s+)?function\s+[\w.]*repair_legacy_statutory_accounts/i.test(
        sql,
      );
    });
    expect(fileWithDef, "Definition migration not located").toBeDefined();
    const sql = readFileSync(join(MIGRATIONS_DIR, fileWithDef!), "utf8");
    expect(
      /account_change_audit_log/i.test(sql),
      "repair_legacy_statutory_accounts must record every archive into account_change_audit_log.",
    ).toBe(true);
  });
});
