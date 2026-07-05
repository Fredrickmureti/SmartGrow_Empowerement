/**
 * Round 7 — return-template body contract test.
 *
 * Pins the structured `localization_pack_return_templates.body` shape
 * that `generate-statutory-return` reads + the editor produces. Same
 * validator code path runs in production.
 */
import { describe, it, expect } from "vitest";
import {
  validateReturnTemplateBody,
  KNOWN_SYSTEM_COLUMN_SOURCES,
  isKnownColumnSource,
} from "../../../supabase/functions/_shared/returnTemplateSchema";
import { __test } from "../../features/localization/components/ReturnTemplateEditor";

describe("return-template body — schema validation", () => {
  it("accepts a realistic return body (country-agnostic, generic rule code)", () => {
    const body = {
      filters: { rule_codes: ["rule_a"], payslip_status: ["approved", "validated", "paid"] },
      columns: [
        { key: "tid", source: "employee.tax_id", label: "Tax ID", format: "text" },
        { key: "name", source: "employee.full_name", label: "Employee", format: "text" },
        { key: "amt", source: "sum_employee_amount", label: "Withheld", format: "currency" },
      ],
      group_by: ["employee_id"],
      totals: ["amt"],
      reconciliation: { rule_code: "rule_a" },
    };
    const r = validateReturnTemplateBody(body);
    expect(r.errors).toEqual([]);
  });

  it("rejects body missing rule_codes", () => {
    const r = validateReturnTemplateBody({
      filters: {},
      columns: [{ key: "x", source: "employee.full_name" }],
    });
    expect(r.errors.some((e) => e.includes("rule_codes"))).toBe(true);
  });

  it("rejects body with empty columns", () => {
    const r = validateReturnTemplateBody({
      filters: { rule_codes: ["rule_a"] },
      columns: [],
    });
    expect(r.errors.some((e) => e.includes("at least one column"))).toBe(true);
  });

  it("rejects totals referencing unknown column key", () => {
    const r = validateReturnTemplateBody({
      filters: { rule_codes: ["rule_a"] },
      columns: [{ key: "amt", source: "sum_employee_amount" }],
      totals: ["nope"],
    });
    expect(r.errors.some((e) => e.includes("does not match any column key"))).toBe(true);
  });

  it("flags duplicate column keys", () => {
    const r = validateReturnTemplateBody({
      filters: { rule_codes: ["rule_a"] },
      columns: [
        { key: "x", source: "sum_employee_amount" },
        { key: "x", source: "sum_employer_amount" },
      ],
    });
    expect(r.errors.some((e) => e.includes("duplicate column key"))).toBe(true);
  });

  it("warns on unknown non-employee source string but does not error", () => {
    const r = validateReturnTemplateBody({
      filters: { rule_codes: ["rule_a"] },
      columns: [{ key: "x", source: "totally_unknown_source" }],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("not a recognised system source"))).toBe(true);
  });

  it("accepts any employee.<key> source for pack-registered identifiers", () => {
    // Country-agnostic: identifier types are pack-defined, not engine-hardcoded.
    // Keys used here are intentionally generic — the resolver does not care
    // what the pack actually calls them.
    const r = validateReturnTemplateBody({
      filters: { rule_codes: ["rule_a"] },
      columns: [
        { key: "id1", source: "employee.tax_id" },
        { key: "id2", source: "employee.stat_id_1" },
        { key: "id3", source: "employee.stat_id_2" },
        { key: "id4", source: "employee.de_steuer_id" },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("warns on totals over a non-numeric column", () => {
    const r = validateReturnTemplateBody({
      filters: { rule_codes: ["rule_a"] },
      columns: [{ key: "name", source: "employee.full_name" }],
      totals: ["name"],
    });
    expect(r.warnings.some((w) => w.includes("non-numeric"))).toBe(true);
  });

  it("KNOWN_SYSTEM_COLUMN_SOURCES covers the country-agnostic reader contract", () => {
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("employee.full_name");
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("employee.employee_number");
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("sum_employee_amount");
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("sum_employer_amount");
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("sum_taxable_amount");
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("sum_total_amount");
    expect(KNOWN_SYSTEM_COLUMN_SOURCES).toContain("count_payslips");
    // No country-specific identifier names baked in (denylist guard).
    expect((KNOWN_SYSTEM_COLUMN_SOURCES as readonly string[])).not.toContain("employee.nssf_number");
    expect((KNOWN_SYSTEM_COLUMN_SOURCES as readonly string[])).not.toContain("employee.shif_number");
    expect((KNOWN_SYSTEM_COLUMN_SOURCES as readonly string[])).not.toContain("employee.nhif_number");
    expect((KNOWN_SYSTEM_COLUMN_SOURCES as readonly string[])).not.toContain("employee.tax_pin");
    // But the helper accepts them dynamically (pack-defined fields).
    expect(isKnownColumnSource("employee.tax_id")).toBe(true);
    expect(isKnownColumnSource("employee.stat_id_1")).toBe(true);
    expect(isKnownColumnSource("employee.de_steuer_id")).toBe(true);
    expect(isKnownColumnSource("employee.statutory_id.nssf")).toBe(true);
    expect(isKnownColumnSource("not_an_employee_source")).toBe(false);
  });
});

describe("ReturnTemplateEditor — body round-trip", () => {
  it("normalize → denormalize is lossless for a default body", () => {
    const orig = __test.defaultBody();
    const round = __test.denormalizeBody(__test.normalizeBody(orig));
    // denormalize re-builds the canonical shape; deep-equal on the
    // fields the runtime reads:
    expect(round.filters.rule_codes).toEqual(orig.filters.rule_codes);
    expect(round.columns).toEqual(orig.columns);
    expect(round.group_by).toEqual(orig.group_by);
    expect(round.totals).toEqual(orig.totals);
  });

  it("normalize fills sensible defaults for an empty body", () => {
    const n = __test.normalizeBody({});
    expect(Array.isArray(n.filters.rule_codes)).toBe(true);
    expect(n.group_by).toEqual(["employee_id"]);
  });

  it("denormalize omits empty totals/payslip_status/reconciliation", () => {
    const out = __test.denormalizeBody({
      filters: { rule_codes: ["PAYE"] },
      columns: [{ key: "x", source: "sum_employee_amount" }],
      group_by: ["employee_id"],
      totals: [],
      reconciliation: null,
    });
    expect(out.totals).toBeUndefined();
    expect(out.filters.payslip_status).toBeUndefined();
    expect(out.reconciliation).toBeUndefined();
  });
});
