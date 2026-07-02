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

  it("custom deduction types can only declare flat_amount or percentage_of_gross", () => {
    // The new typed picker enforces the engine contract for tenant-defined
    // deduction types.
    expect(PAGE).toMatch(/CUSTOM_TYPE_METHODS/);
    expect(PAGE).toMatch(/value:\s*"flat_amount"/);
    expect(PAGE).toMatch(/value:\s*"percentage_of_gross"/);
    // The old freeform builder is gone.
    expect(PAGE).not.toMatch(/addParamField|removeParamField|updateParamField/);
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
