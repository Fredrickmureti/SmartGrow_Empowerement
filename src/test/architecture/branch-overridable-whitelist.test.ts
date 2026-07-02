/**
 * Architecture guard — fails CI if any future migration adds an
 * accounting-sensitive key to `branch_overridable_settings`.
 *
 * Tax / currency / journal / chart-of-accounts / fiscal-period settings
 * MUST stay company-scoped (Odoo res.company model). Allowing branch
 * overrides for these would silently corrupt accounting consolidation.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_KEY_PATTERNS = [
  /^tax(_|$)/i,
  /^currency(_|$)/i,
  /^base_currency$/i,
  /^journal(_|$)/i,
  /^accounting(_|$)/i,
  /^coa(_|$)/i,
  /^chart_of_accounts(_|$)/i,
  /^fiscal(_|$)/i,
  /^period_lock/i,
  /^tax_lock/i,
];

const MIGRATIONS_DIR = "supabase/migrations";

function migrationFiles(): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(MIGRATIONS_DIR); } catch { return []; }
  return entries
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(MIGRATIONS_DIR, f))
    .filter((f) => statSync(f).isFile());
}

describe("branch-overridable-whitelist architecture guard", () => {
  it("no migration seeds an accounting-sensitive key into branch_overridable_settings", () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const sql = readFileSync(file, "utf8");
      // Match `INSERT INTO public.branch_overridable_settings … VALUES (…)` blocks.
      const re = /INSERT\s+INTO\s+(?:public\.)?branch_overridable_settings[\s\S]*?VALUES([\s\S]*?);/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(sql))) {
        const valuesBlock = m[1];
        // Each VALUES row starts with ('the_key', …)
        const keyRe = /\(\s*['"]([a-z0-9_]+)['"]/gi;
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(valuesBlock))) {
          const key = km[1];
          for (const pat of FORBIDDEN_KEY_PATTERNS) {
            if (pat.test(key)) {
              offenders.push(`${file}  ::  forbidden key '${key}' (${pat})`);
            }
          }
        }
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Branch-overridable whitelist must NOT include accounting-sensitive keys:\n` +
          offenders.join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });
});
