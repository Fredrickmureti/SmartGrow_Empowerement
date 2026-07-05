/**
 * Regression test — pins the `payroll_employee_ytd_rollup` signature
 * against the edge-function caller. The previous audit assumed a 4-arg
 * shape and would have broken production; this test locks the real
 * 2-arg shape and the exact call site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(rel: string) {
  return readFileSync(resolve(__dirname, "../../../", rel), "utf8");
}

describe("payroll_employee_ytd_rollup signature", () => {
  it("edge function calls the RPC with p_year + p_employee_id only", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).toMatch(/rpc\(["']payroll_employee_ytd_rollup["']/);
    expect(src).toMatch(/p_year:\s*body\.fiscal_year/);
    expect(src).toMatch(/p_employee_id:\s*emp\.id/);
    // Explicitly forbid the misdiagnosed 4-arg call that the previous
    // audit proposed; the real RPC has no p_organization_id parameter.
    expect(src).not.toMatch(/payroll_employee_ytd_rollup[\s\S]{0,200}p_organization_id/);
  });

  it("migration defines the RPC as (p_year, p_employee_id)", () => {
    const src = read(
      "supabase/migrations/20260510081521_7e3f52aa-2e18-41d0-9ad9-54aa74f92bde.sql",
    );
    expect(src).toMatch(
      /CREATE OR REPLACE FUNCTION public\.payroll_employee_ytd_rollup\([^)]*p_year integer[^)]*p_employee_id uuid[^)]*\)/,
    );
  });
});

describe("template-not-installed errors are structured (not raw 404/500)", () => {
  it("generate-tax-certificate returns a TEMPLATE_NOT_INSTALLED businessError with recovery hint", () => {
    const src = read("supabase/functions/generate-tax-certificate/index.ts");
    expect(src).toContain("TEMPLATE_NOT_INSTALLED");
    expect(src).toMatch(/businessError\(\s*404,\s*["']TEMPLATE_NOT_INSTALLED["']/);
    // Actionable recovery guidance is part of the contract with the UI.
    expect(src).toMatch(/Localization\s*→\s*Packs/);
  });

  it("generate-statutory-return returns a TEMPLATE_NOT_INSTALLED businessError with recovery hint", () => {
    const src = read("supabase/functions/generate-statutory-return/index.ts");
    expect(src).toContain("TEMPLATE_NOT_INSTALLED");
    expect(src).toMatch(/businessError\(\s*404,\s*["']TEMPLATE_NOT_INSTALLED["']/);
    expect(src).toMatch(/Localization\s*→\s*Packs/);
  });
});
