/**
 * ADR-0062 regression + architecture guard.
 *
 * The KE statutory return templates (P10, P10A, P10D, NSSF_RET, SHIF_RET,
 * AHL_RET) used to bind columns labelled "Gross Pay" / "Annual Gross Pay" /
 * "Pensionable Pay" to `source: sum_taxable_amount`, so NSSF/PAYE/etc.
 * returns rendered *taxable income* under a "Gross Pay" header.
 *
 * This test:
 *   1. Statically greps the KE seed migration to ensure no `gross*` column
 *      key is ever bound to `sum_taxable_amount` again.
 *   2. Symmetrically ensures no `taxable*` column key is bound to
 *      `sum_gross_amount` (would be the mirror mistake).
 *
 * The runtime rebind of already-installed tenants is asserted in-database by
 * the ADR-0062 data migration's post-condition DO $$ block.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const KE_SEED = readFileSync(
  resolve(
    __dirname,
    "../../../supabase/migrations/20260620001436_406718e2-4677-4bf2-93a2-fbdf733b4bf1.sql",
  ),
  "utf8",
);

// jsonb_build_object('key','<k>','label','<l>','source','<s>')
const COLUMN_RE =
  /jsonb_build_object\s*\(\s*'key'\s*,\s*'([^']+)'[^)]*?'source'\s*,\s*'([^']+)'\s*\)/g;

interface Col {
  key: string;
  source: string;
}

function extractColumns(src: string): Col[] {
  const out: Col[] = [];
  for (const m of src.matchAll(COLUMN_RE)) {
    out.push({ key: m[1], source: m[2] });
  }
  return out;
}

describe("ADR-0062 — KE return templates: gross vs taxable binding", () => {
  const cols = extractColumns(KE_SEED);

  it("extracted a reasonable number of columns from the seed", () => {
    // Sanity: the file defines several templates × several columns each.
    expect(cols.length).toBeGreaterThan(10);
  });

  it("no gross-labelled column is bound to sum_taxable_amount", () => {
    const offenders = cols.filter(
      (c) => /^gross/i.test(c.key) && c.source === "sum_taxable_amount",
    );
    expect(offenders).toEqual([]);
  });

  it("no taxable-labelled column is bound to sum_gross_amount (mirror check)", () => {
    const offenders = cols.filter(
      (c) => /^taxable/i.test(c.key) && c.source === "sum_gross_amount",
    );
    expect(offenders).toEqual([]);
  });

  it("no pensionable-labelled column is bound to sum_taxable_amount", () => {
    // Pensionable earnings are, per ADR-0062, gross-equivalent until the
    // follow-up sum_rule_base.<code> lands. They must not read taxable.
    const offenders = cols.filter(
      (c) => /pensionable/i.test(c.key) && c.source === "sum_taxable_amount",
    );
    expect(offenders).toEqual([]);
  });
});
