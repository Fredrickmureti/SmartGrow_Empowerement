/**
 * Statutory returns must consume durable statutory component bindings, not only
 * string-matched rule codes. This guards the voluntary/byproduct contribution
 * lifecycle for every localization pack: custom deduction/component → payslip
 * result → statutory_reporting_bindings → return column → gov artifact.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const RETURN_FN = readFileSync(join(ROOT, "supabase/functions/generate-statutory-return/index.ts"), "utf8");
const RESOLVER = readFileSync(join(ROOT, "supabase/functions/_shared/returnSourceResolver.ts"), "utf8");

describe("statutory return component bindings", () => {
  it("loads reporting bindings and payslip scheme_component_id", () => {
    expect(RETURN_FN).toMatch(/from\(["']statutory_reporting_bindings["']\)/);
    expect(RETURN_FN).toMatch(/scheme_component_id, column_key, side/);
    expect(RETURN_FN).toMatch(/payslip_lines[\s\S]{0,160}?scheme_component_id/);
  });

  it("resolves bound return columns before falling back to source tokens", () => {
    expect(RETURN_FN).toMatch(/bindingsByColumn/);
    expect(RETURN_FN).toMatch(/resolveBoundColumnValue/);
    expect(RETURN_FN).toMatch(/readColumnSource/);
    expect(RETURN_FN).toMatch(/Object\.prototype\.hasOwnProperty\.call\(ctx\.sums\.byColumn, col\.key\)/);
  });

  it("keeps government files aligned with component-bound return columns", () => {
    expect(RETURN_FN).toMatch(/boundSubmissionColumns/);
    expect(RETURN_FN).toMatch(/columnKeyByLabel/);
    expect(RETURN_FN).toMatch(/sums\.byColumn\?\.\[binding\.columnKey\]/);
  });

  it("resolver supports internal bound column values without exposing country-specific sources", () => {
    expect(RESOLVER).toMatch(/byColumn\?:\s*Record<string, unknown>/);
    expect(RESOLVER).toMatch(/const BOUND_COLUMN =/);
    expect(RESOLVER).toMatch(/BOUND_COLUMN\.exec\(source\)/);
    expect(RESOLVER).not.toMatch(/nssf_voluntary|NSSF_RET|Kenya/);
  });
});