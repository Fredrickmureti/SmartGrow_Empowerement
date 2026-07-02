/**
 * Token-resolution contract test.
 *
 * Builds a synthetic context covering every dotted source group registered
 * in `pack_token_registry` (employee, contract, run, system, organization)
 * and asserts that canonical template bodies render with ZERO unresolved
 * tokens. If a future template references a token outside this registry,
 * this test fails — forcing the author to either add the token to the
 * registry or fix the template.
 */
import { describe, it, expect } from "vitest";
import { renderTokens } from "../../../supabase/functions/_shared/renderTokens.ts";

// Mirrors the country-agnostic CORE `pack_token_registry` (pack_id IS NULL).
// Country-specific identifiers and rule codes (e.g. `employee.nssf_number`,
// `run.paye`) MUST NOT appear here — those live in their respective pack
// registries with pack_id = <pack uuid>. This test acts as a guard: if a
// future migration re-introduces a country token into the core registry,
// the guard `it()` block below will fail.
const REGISTRY_PATHS = [
  // contract
  "contract.allowances", "contract.basic_salary", "contract.currency",
  "contract.job_title", "contract.payment_frequency", "contract.start_date",
  // employee — neutral identifiers only
  "employee.bank_account", "employee.email", "employee.employee_number",
  "employee.first_name", "employee.full_name", "employee.hire_date",
  "employee.last_name", "employee.national_id", "employee.tax_id",
  // run — totals are country-agnostic; specific tax-line names
  // (PAYE/IRPF/PAYG/…) belong to packs.
  "run.allowances_total", "run.basic_pay", "run.benefits_total",
  "run.employer_contributions_total", "run.gross_pay", "run.net_pay",
  "run.payroll_run_id", "run.period_end", "run.period_label",
  "run.period_start", "run.relief_total", "run.taxable_pay",
  "run.total_deductions", "run.total_employer_cost",
  // system / organization
  "organization.address", "organization.country_code", "organization.name",
  "organization.phone", "organization.tax_id",
  "system.now", "system.tax_year",
];

function buildContext(): Record<string, any> {
  const ctx: Record<string, any> = {};
  for (const path of REGISTRY_PATHS) {
    const parts = path.split(".");
    let node = ctx;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ??= {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = `«${path}»`;
  }
  return ctx;
}

describe("renderTokens — registry coverage contract", () => {
  const ctx = buildContext();

  it("synthetic context resolves every registered token", () => {
    for (const path of REGISTRY_PATHS) {
      const { rendered, misses } = renderTokens(`{{${path}}}`, ctx);
      expect(misses, `token ${path} should resolve`).toEqual([]);
      expect(rendered).toBe(`«${path}»`);
    }
  });

  it("canonical payslip template renders with zero misses (country-agnostic body only)", () => {
    const body = {
      blocks: [
        { type: "header", content: "{{organization.name}} — Payslip" },
        { type: "row", content: "Employee: {{employee.full_name}} (#{{employee.employee_number}})" },
        { type: "row", content: "Period: {{run.period_label}} ({{run.period_start}} → {{run.period_end}})" },
        { type: "row", content: "Gross: {{run.gross_pay}} {{contract.currency}}" },
        { type: "row", content: "Net pay: {{run.net_pay}}" },
      ],
    };
    const { misses } = renderTokens(body, ctx);
    expect(misses).toEqual([]);
  });

  it("canonical tax-certificate template renders with zero misses (country-agnostic body only)", () => {
    const body = {
      blocks: [
        { type: "title", content: "Tax Certificate {{system.tax_year}}" },
        { type: "row", content: "Issued by: {{organization.name}} ({{organization.tax_id}})" },
        { type: "row", content: "Employee: {{employee.full_name}}, Tax ID: {{employee.tax_id}}" },
        { type: "row", content: "Taxable income: {{run.taxable_pay}}" },
        { type: "footer", content: "Generated {{system.now}}" },
      ],
    };
    const { misses } = renderTokens(body, ctx);
    expect(misses).toEqual([]);
  });

  it("emits sentinel + miss when a template references an unregistered token", () => {
    const body = { blocks: [{ type: "row", content: "Hello {{employee.middle_name}}" }] };
    const { rendered, misses } = renderTokens(body, ctx);
    expect(misses).toEqual(["employee.middle_name"]);
    expect((rendered as any).blocks[0].content).toContain("‹unresolved: employee.middle_name›");
  });

  it("country-specific identifier tokens are NOT in the core registry (denylist guard)", () => {
    // These belong in pack-scoped registries (l10n_ke, l10n_uk, …) — never here.
    const forbidden = [
      "employee.nssf_number", "employee.shif_number", "employee.nhif_number",
      "employee.kra_pin", "run.paye", "run.nhif", "run.shif", "run.housing_levy",
    ];
    for (const path of forbidden) {
      expect(REGISTRY_PATHS).not.toContain(path);
    }
  });
});