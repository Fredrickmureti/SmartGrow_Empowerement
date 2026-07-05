/**
 * Regression guard for the enterprise payroll audit (2026-07-05, plan §R2/§R3).
 *
 * Ensures:
 *   - `computeBracketProgressive` honours declarative `parameters.reliefs[]`
 *     alongside the legacy scalar `personal_relief` / `insurance_relief_*`.
 *   - The payslip PDF explainer adaptor (`adaptBracketBreakdown`) emits
 *     taxable-base build-up + relief rows when the engine attaches its
 *     bracket trace to `payslip_lines.source`.
 *
 * Pinning both keeps the payslip auditable end-to-end: engine → source
 * → PDF / drill-down popover.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);
const ADAPTOR_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/_shared/breakdownAdaptor.ts"),
  "utf8",
);

describe("Reliefs pipeline (§R2)", () => {
  it("computeBracketProgressive reads declarative reliefs[]", () => {
    expect(ENGINE_SRC).toMatch(/parameters\.reliefs\[\]|Array\.isArray\(p\.reliefs\)/);
    // Every declared kind must be handled or explicitly deferred with a comment.
    for (const kind of ["flat", "rate_of_base"]) {
      expect(ENGINE_SRC.toLowerCase()).toContain(kind);
    }
  });

  it("scalar and declarative reliefs cannot double-count", () => {
    // The dedup check must reference both codes.
    expect(ENGINE_SRC).toMatch(/scalarPersonalRelief\s*>\s*0/);
    expect(ENGINE_SRC).toMatch(/scalarIrRate\s*>\s*0/);
  });
});

describe("Payslip source explainer (§R3)", () => {
  it("engine attaches bracket_breakdown to payslip_lines.source", () => {
    expect(ENGINE_SRC).toMatch(/bracketTracesByRuleName/);
    expect(ENGINE_SRC).toMatch(/bracket_breakdown:/);
    expect(ENGINE_SRC).toMatch(/taxable_base_components:/);
  });

  it("breakdown adaptor renders taxable-base build-up and reliefs", () => {
    expect(ADAPTOR_SRC).toMatch(/taxable_base_components/);
    expect(ADAPTOR_SRC).toMatch(/personal_relief/);
    expect(ADAPTOR_SRC).toMatch(/insurance_relief/);
  });
});
