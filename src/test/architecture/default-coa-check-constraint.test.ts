import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — R2 of the COA re-audit.
 *
 * The `no_statutory_in_neutral_seed` CHECK constraint is the database's
 * last line of defence: even if every higher layer is bypassed, Postgres
 * itself rejects rows that carry country-specific statutory keywords
 * while flagged country-neutral.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

describe("no_statutory_in_neutral_seed CHECK constraint remains in place", () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("no migration drops the CHECK constraint", () => {
    const violations: string[] = [];
    // The R1 migration uses idempotent DROP CONSTRAINT IF EXISTS before
    // ADD CONSTRAINT (same transaction). Skip its self-references.
    const RECREATE_ALLOWLIST = new Set<string>([
      "20260428181019_5c8f8cb4-db00-45fe-96d1-e1325d85103f.sql",
    ]);
    for (const file of files) {
      if (RECREATE_ALLOWLIST.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (
        /alter\s+table[^;]*default_chart_of_accounts[^;]*drop\s+constraint[^;]*no_statutory_in_neutral_seed/i.test(
          sql,
        )
      ) {
        violations.push(file);
      }
    }
    expect(
      violations,
      `Database-level statutory guard was removed by:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the CHECK constraint is created in migration history", () => {
    const found = files.some((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      return /add\s+constraint\s+no_statutory_in_neutral_seed/i.test(sql);
    });
    expect(
      found,
      "no_statutory_in_neutral_seed CHECK constraint is missing from migration history.",
    ).toBe(true);
  });
});
