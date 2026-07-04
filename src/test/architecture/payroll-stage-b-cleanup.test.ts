/**
 * Stage B cleanup guard.
 *
 * The legacy form state and `saveRuleMutation` in PayrollStatutoryRules.tsx
 * created statutory rules that bypassed `computation_method` — exactly the
 * shape the engine could no longer dispatch. They were removed in favour of
 * the engine-driven `StatutoryRuleEditor`. These tests fail if anyone
 * resurrects the legacy path or re-introduces the freeform parameter-schema
 * builder for custom deduction types.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const PAGE = readFileSync(
  join(process.cwd(), "src/pages/hr/PayrollStatutoryRules.tsx"),
  "utf8",
);

describe("payroll architecture guard — Stage B cleanup", () => {
  it("legacy rule form state is gone from PayrollStatutoryRules.tsx", () => {
    // These identifiers were the dead-code path. Allow them only inside
    // explanatory comments (the comments document why they were removed).
    const codeOnly = PAGE.split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

    for (const sym of [
      "formRuleType",
      "formRuleName",
      "formCountryCode",
      "formEffectiveFrom",
      "formEffectiveTo",
      "formSortOrder",
      "formIsActive",
      "formParameters",
      "currentSchema",
      "handleSaveRule",
    ]) {
      expect(codeOnly).not.toMatch(new RegExp(`\\b${sym}\\b`));
    }
  });

  it("saveRuleMutation is no longer declared", () => {
    // Match the declaration only — the comment that mentions removal is fine.
    expect(PAGE).not.toMatch(/const\s+saveRuleMutation\s*=/);
  });

  it("rule type definitions expose engine-known computation methods only", () => {
    // Slice 1 of the Custom Deduction Types audit widened the picker beyond
    // the original flat_amount / percentage_of_gross pair to cover the full
    // set the compute-payroll engine can dispatch. The catalog lives in the
    // dialog module now — check there, not in the Statutory Rules page.
    const DIALOG = readFileSync(
      join(process.cwd(), "src/components/payroll/CustomDeductionTypeDialog.tsx"),
      "utf8",
    );
    expect(DIALOG).toMatch(/RULE_TYPE_METHODS/);
    for (const method of [
      "flat_amount",
      "percentage_of_gross",
      "bracket_progressive",
      "tiered_brackets",
      "per_employee_flat",
    ]) {
      expect(DIALOG).toMatch(new RegExp(`value:\\s*"${method}"`));
    }
    // The old freeform parameter-field builder must stay gone.
    expect(DIALOG).not.toMatch(/addParamField|removeParamField|updateParamField/);
  });

  it("a Stage-B migration locking computation_method exists", () => {
    const hits = execSync(
      "rg -l 'payroll_statutory_rules_method_known' supabase/migrations/ || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(hits.length).toBeGreaterThan(0);
  });
});
