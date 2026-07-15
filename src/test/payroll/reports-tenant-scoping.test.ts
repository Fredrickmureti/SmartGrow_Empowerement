/**
 * Architecture guards for the Payroll Reports catalogue (ADR-0062 §6).
 *
 * The Ghana-reports-in-Kenya leak that motivated this test was caused by
 * two drift patterns:
 *   1. The reports UI queried `payroll_report_definitions` directly and
 *      filtered by `businesses.country_code` on the client. That mixes
 *      "which country is this legal entity in" with "which localization
 *      packs are installed" — different questions with different answers.
 *   2. The pack-sync function seeded rows for every pack that exists in
 *      the platform, so anyone reading the table saw every country.
 *
 * The fix is a single security-definer RPC —
 * `payroll_report_definitions_for_tenant` — that scopes visibility by
 * `installed_localization_packs`. These source-level tests pin that
 * boundary so a future refactor can't reintroduce direct table reads
 * or a country-code filter.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(__dirname, "../../../");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

describe("payroll reports catalogue is tenant-scoped", () => {
  it("no source file reads `payroll_report_definitions` directly — must go via the RPC", () => {
    const files = walk(resolve(ROOT, "src"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("payroll_report_definitions")) continue;
      // Allowed: type imports and the generated Supabase types file.
      if (f.endsWith("integrations/supabase/types.ts")) continue;
      // Allowed: the canonical hook that owns the RPC call.
      if (f.endsWith("usePayrollReportDefinitions.ts")) continue;
      // Allowed: this test file itself.
      if (f.endsWith("reports-tenant-scoping.test.ts")) continue;
      // Direct .from("payroll_report_definitions") is the drift we forbid.
      if (/\.from\(\s*["']payroll_report_definitions["']\s*\)/.test(src)) {
        offenders.push(f.replace(ROOT + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the catalogue hook calls the tenant-scoped RPC, not the raw table", () => {
    const src = readFileSync(
      resolve(ROOT, "src/hooks/payroll/usePayrollReportDefinitions.ts"),
      "utf8",
    );
    expect(src).toMatch(/rpc\(\s*["']payroll_report_definitions_for_tenant["']/);
    // The old client-side country filter is gone.
    expect(src).not.toMatch(/r\.country_code === countryCode/);
  });

  it("no reports UI file filters by `currentBusiness.country_code`", () => {
    const files = walk(resolve(ROOT, "src/pages/hr/payroll/reports"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/currentBusiness\s*as\s*any\s*\)\?\.country_code/.test(src)) {
        offenders.push(f.replace(ROOT + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });
});
