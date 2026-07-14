/**
 * ADR-0062 architecture guard.
 *
 * Prevents *future* KE (or any) seed / update migrations from re-binding a
 * gross-labelled statutory-return column to `sum_taxable_amount`, or vice
 * versa. The historical seed migration 20260620001436 is intentionally
 * allow-listed — its rows were repointed at install time via the ADR-0062
 * data-update migration (see the runtime post-condition DO $$ block), and
 * new tenants pick up the corrected `localization_pack_return_templates`
 * rows from the DB, not from that historical file.
 *
 * The runtime contract of `sum_gross_amount` is pinned by
 * `return-source-resolver-gross.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS_DIR = resolve(__dirname, "../../../supabase/migrations");

// Historical seed that shipped the defect; rebound at runtime by the
// ADR-0062 data migration. Do not edit — migration files are immutable.
const ALLOW_LIST = new Set<string>([
  "20260620001436_406718e2-4677-4bf2-93a2-fbdf733b4bf1.sql",
]);

// jsonb_build_object('key','<k>', … 'source','<s>' … )
const COLUMN_RE =
  /jsonb_build_object\s*\(\s*'key'\s*,\s*'([^']+)'[^)]*?'source'\s*,\s*'([^']+)'\s*\)/g;

interface Offender {
  file: string;
  key: string;
  source: string;
}

function scanMigrations(): { grossToTaxable: Offender[]; taxableToGross: Offender[] } {
  const grossToTaxable: Offender[] = [];
  const taxableToGross: Offender[] = [];
  const entries = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  for (const file of entries) {
    if (ALLOW_LIST.has(file)) continue;
    const full = join(MIGRATIONS_DIR, file);
    if (!statSync(full).isFile()) continue;
    const src = readFileSync(full, "utf8");
    for (const m of src.matchAll(COLUMN_RE)) {
      const [, key, source] = m;
      if (/^gross/i.test(key) && source === "sum_taxable_amount") {
        grossToTaxable.push({ file, key, source });
      }
      if (/^taxable/i.test(key) && source === "sum_gross_amount") {
        taxableToGross.push({ file, key, source });
      }
    }
  }
  return { grossToTaxable, taxableToGross };
}

describe("ADR-0062 — no return template may misbind gross vs taxable", () => {
  const { grossToTaxable, taxableToGross } = scanMigrations();

  it("no NEW migration binds a gross-labelled column to sum_taxable_amount", () => {
    expect(grossToTaxable).toEqual([]);
  });

  it("no NEW migration binds a taxable-labelled column to sum_gross_amount", () => {
    expect(taxableToGross).toEqual([]);
  });
});
