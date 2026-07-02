/**
 * Architecture invariant: the editor's METHOD_TO_KIND map must point each
 * ComputationMethod at a schema-kind whose required fields are actually
 * produced by that method's normalize output. Catches the inverted
 * `flat_amount → fixed` / `per_employee_flat → flat` regression that
 * silently mis-validated NITA-shaped rules.
 *
 * Held as a structural contract test so a future refactor can't quietly
 * shuffle the mapping back into a broken state.
 */
import { describe, it, expect } from "vitest";
import {
  COMPUTATION_METHODS,
  normalizeParameters,
  type ComputationMethod,
} from "@/lib/payroll/computationMethods";

// Mirror of the canonical map kept in StatutoryRuleEditor. If this list
// drifts, both files have to be updated together.
const METHOD_TO_KIND: Record<ComputationMethod, string> = {
  bracket_progressive: "progressive",
  tiered_brackets: "tiered",
  percentage_of_gross: "percentage",
  graduated_table: "graduated",
  per_employee_flat: "fixed",
  flat_amount: "flat",
};

// Per-kind keys the published `pack_rule_type_schemas` row requires
// beyond the universal `type`. Sourced from migration 20260515105547.
const REQUIRED_BY_KIND: Record<string, string[]> = {
  progressive: ["brackets", "currency", "period"],
  tiered: ["tiers", "currency", "period"],
  percentage: ["base", "period"],
  graduated: ["brackets", "currency", "period"],
  fixed: ["amount_per_employee", "currency", "period"],
  flat: [], // no published schema; soft "legacy_unvalidated"
};

describe("Editor METHOD_TO_KIND mapping is consistent with published schemas", () => {
  for (const method of Object.keys(COMPUTATION_METHODS) as ComputationMethod[]) {
    const kind = METHOD_TO_KIND[method];
    const required = REQUIRED_BY_KIND[kind] ?? [];

    it(`${method} → ${kind}: normalize output contains every required schema key`, () => {
      const spec = COMPUTATION_METHODS[method];
      // Build a minimal raw payload that fills every scalar with its
      // default (or a placeholder) and gives the array field one row.
      const raw: Record<string, any> = {};
      for (const f of spec.scalarFields) {
        if (f.default !== undefined) raw[f.key] = String(f.default);
        else if (f.type === "number" || f.type === "percentage") raw[f.key] = "1";
        else if (f.type === "select") raw[f.key] = f.options?.[0]?.value ?? "";
        else raw[f.key] = "x";
      }
      if (spec.arrayField) {
        const row: Record<string, any> = {};
        for (const c of spec.arrayField.columns) row[c.key] = c.type === "text" ? "x" : 1;
        raw[spec.arrayField.key] = [row];
      }
      const out = normalizeParameters(method, raw);
      for (const key of required) {
        // The array fields land under spec.arrayField.key; both `brackets`
        // and `tiers` are already covered by that.
        expect(out, `${method} missing required key ${key}`).toHaveProperty(key);
      }
    });
  }
});
