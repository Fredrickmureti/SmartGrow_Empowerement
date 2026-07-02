/**
 * Architecture guard — deprecated payroll tables
 *
 * `payroll_remittances` was superseded by `payroll_liabilities` +
 * `payroll_remittance_payments`. `employments` was superseded by
 * `employee_contracts`. No edge function or `src/` runtime code may select
 * from or write to either table. Architecture tests, factories, and the
 * existing legacy guards may still reference them by name.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const DEPRECATED = ["payroll_remittances", "employments"];

const ALLOWLIST: RegExp[] = [
  /^src\/test\//,
  /^supabase\/tests\//,
  /^supabase\/migrations\//,
  /^src\/integrations\/supabase\/types\.ts$/,
  // Legacy guards that already assert no client writes:
  /no-client-write-payroll-remittances\.test\.ts$/,
  /no-dropped-payroll-tables\.test\.ts$/,
  // Grandfathered pre-existing consumers — tracked for removal in the
  // dedicated cleanup pass after one release cycle with the new tables.
  // NEW code must use payroll_liabilities + payroll_remittance_payments
  // (for remittances) and employee_contracts (for employments).
  /^supabase\/functions\/post-remittance-payment\/index\.ts$/,
  /^supabase\/functions\/_shared\/reports\/payrollData\.ts$/,
  /^src\/hooks\/hr\/useEmployments\.ts$/,
];

describe("deprecated payroll tables guard", () => {
  for (const table of DEPRECATED) {
    it(`no code reads or writes to public.${table}`, () => {
      // Match `.from("table")` / `.from('table')` style references.
      const pattern = `\\.from\\(['\"]${table}['\"]\\)`;
      const out = execSync(
        `rg --files-with-matches "${pattern}" src supabase/functions || true`,
        { encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean)
        .filter((p) => !ALLOWLIST.some((re) => re.test(p)));
      expect(out, `Deprecated table ${table} accessed in:\n${out.join("\n")}`).toEqual([]);
    });
  }
});