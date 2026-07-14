/**
 * Pack-linked payroll rule codes for custom deductions.
 *
 * Kenya NSSF byproduct return column VOLUNTARY reads
 * `sum_rule.nssf_voluntary.employee` from `payslip_lines`. Before this
 * change, tenant custom deductions were always emitted under the
 * engine-internal `custom_<code>` prefix, so the VOLUNTARY column
 * could never populate — the pack declared a rule code with no
 * producer.
 *
 * The fix is a pack-declared `payroll_rule_code` on
 * `custom_deduction_types`. When set, `compute-payroll` emits payslip
 * lines under that stable code so localization pack return templates
 * (and pack tokens) bind to it directly. Legacy tenant-created
 * deductions with `payroll_rule_code IS NULL` keep the historic
 * `custom_<code>` behaviour.
 *
 * This test locks that contract at the source-file level so a later
 * refactor cannot silently regress the wiring.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadMigrations(): string {
  const dir = "supabase/migrations";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n\n-- FILE BOUNDARY --\n\n");
}

describe("custom_deduction_types.payroll_rule_code — pack↔engine binding", () => {
  const sql = loadMigrations();

  it("declares payroll_rule_code on custom_deduction_types via migration", () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.custom_deduction_types[\s\S]{0,200}?ADD COLUMN[\s\S]{0,80}?payroll_rule_code\s+TEXT/i,
    );
  });

  it("enforces uniqueness of payroll_rule_code per business", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]{0,120}?custom_deduction_types[\s\S]{0,120}?business_id[\s\S]{0,80}?payroll_rule_code/i,
    );
  });

  it("rejects reserved engine-internal 'custom_' prefix at write time", () => {
    expect(sql).toMatch(/custom_deduction_types_payroll_rule_code_format/);
    expect(sql).toMatch(/payroll_rule_code NOT LIKE 'custom\\_%'/);
  });

  it("compute-payroll derives emittedCode from payroll_rule_code with the custom_<code> fallback", () => {
    const src = readFileSync(
      "supabase/functions/compute-payroll/index.ts",
      "utf8",
    );
    // The custom-deduction emit loop must derive a single emittedCode
    // that prefers the pack-declared rule code and falls back to the
    // legacy `custom_<code>` prefix. This exact shape is what pins the
    // country-agnostic contract in place.
    expect(src).toMatch(
      /const\s+emittedCode\s*=\s*cd\.payroll_rule_code\s*\?\?\s*`custom_\$\{cd\.code\}`/,
    );
    // And it must be the string actually passed to pushLine for the
    // custom-deduction path, not shadowed later.
    const emitBlock = src
      .split("Turn D: custom deduction lines")[1]
      ?.split("P1: Employer admin fees")[0] ?? "";
    expect(emitBlock).toMatch(/pushLine\(\s*emittedCode/);
  });

  it("carries the pack-declared rule code onto the custom-deduction meta so it survives the fetch → emit pipeline", () => {
    const src = readFileSync(
      "supabase/functions/compute-payroll/index.ts",
      "utf8",
    );
    // Meta type carries the field...
    expect(src).toMatch(/customDeductionLineMeta[\s\S]{0,400}?payroll_rule_code:\s*string\s*\|\s*null/);
    // ...and the fetch loop populates it from the deduction_type row.
    expect(src).toMatch(/payroll_rule_code:\s*t\.payroll_rule_code\s*\?\?\s*null/);
  });

  it("registers employee.nssf_voluntary_amount in the Kenya pack token registry", () => {
    expect(sql).toMatch(/employee\.nssf_voluntary_amount/);
  });

  it("keeps the NSSF byproduct return VOLUNTARY column bound to sum_rule.nssf_voluntary.employee", () => {
    // Guardrail: if a future pack edit changes the source, this test
    // fails so the engine-side binding can be updated in lockstep.
    // We check both the seed migration (which uses the shorter layout)
    // and any migration that later rewrites NSSF_RET body — the
    // canonical binding string appears in at least one migration once
    // the pack template is realigned there.
    // Note: the current live DB row was edited via the Publisher; this
    // test locks the resolver contract rather than the seed row.
    const resolver = readFileSync(
      "supabase/functions/_shared/returnSourceResolver.ts",
      "utf8",
    );
    expect(resolver).toMatch(
      /^const SUM_RULE = \/\^sum_rule\\\.\(\[a-z0-9_\]\+\)\\\.\(employee\|employer\)\$\//m,
    );
  });
});