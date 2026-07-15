/**
 * ADR-0062 addendum — reliefs must surface as informational payslip_lines.
 *
 * Static guard on the compute-payroll engine: whenever a
 * `bracket_progressive` rule's trace carries a non-zero personal_relief
 * or insurance_relief, the engine must emit a separate payslip line
 * with:
 *   - rule_code `personal_relief` / `insurance_relief`
 *   - category = rule_type = "relief"
 *   - positive employee_amount (so pack-authored derived columns like
 *     P9's `paye_gross = sum(paye_net, personal_relief, insurance_relief)`
 *     reconstruct the pre-relief tax)
 *   - taxable = false
 *   - `source.parent_rule_code` + `source.computed_from = "bracket_trace"`
 *
 * Emission MUST live directly after the parent tax line's pushLine so
 * the relief lines share the same trace/rule scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("Reliefs surfaced as payslip_lines (ADR-0062 addendum)", () => {
  it("emits a personal_relief informational line from the bracket trace", () => {
    const idx = ENGINE_SRC.indexOf(`"personal_relief",\n            "relief",`);
    expect(idx, "personal_relief pushLine call is missing").toBeGreaterThan(0);
    const win = ENGINE_SRC.slice(idx, idx + 800);
    expect(win).toMatch(/"Personal Relief"/);
    // Positive amount (variable, not a Math.abs on a negated form).
    expect(win).toMatch(/personalReliefSum \* 100/);
    // Not taxable.
    expect(win).toMatch(/false,\s*\n\s*"relief"/);
    // Provenance stamp.
    expect(win).toMatch(/parent_rule_code:\s*code/);
    expect(win).toMatch(/computed_from:\s*"bracket_trace"/);
  });

  it("emits an insurance_relief informational line from the bracket trace", () => {
    const idx = ENGINE_SRC.indexOf(`"insurance_relief",\n            "relief",`);
    expect(idx, "insurance_relief pushLine call is missing").toBeGreaterThan(0);
    const win = ENGINE_SRC.slice(idx, idx + 800);
    expect(win).toMatch(/"Insurance Relief"/);
    expect(win).toMatch(/insuranceReliefSum \* 100/);
    expect(win).toMatch(/false,\s*\n\s*"relief"/);
  });

  it("guards emission on non-zero relief values (no clutter for empty reliefs)", () => {
    // Both pushes MUST be inside `if (X > 0)` blocks.
    const pr = ENGINE_SRC.indexOf(`if (personalReliefSum > 0)`);
    const ir = ENGINE_SRC.indexOf(`if (insuranceReliefSum > 0)`);
    expect(pr).toBeGreaterThan(0);
    expect(ir).toBeGreaterThan(0);
  });

  it("relief emission is sourced from bracketTracesByRuleName (not global constants)", () => {
    const emitIdx = ENGINE_SRC.indexOf(`if (personalReliefSum > 0)`);
    const traceWalk = ENGINE_SRC.lastIndexOf(`Object.entries(bracketTracesByRuleName)`, emitIdx);
    expect(traceWalk).toBeGreaterThan(0);
    expect(emitIdx - traceWalk).toBeLessThan(1200);
  });

  it("does not fold reliefs into deductionsDetail totals", () => {
    // deductionsDetail must not gain a personal_relief / insurance_relief key.
    // (The parent PAYE line already carries the post-relief amount.)
    expect(ENGINE_SRC).not.toMatch(/deductionsDetail\[["']personal_relief["']\]/);
    expect(ENGINE_SRC).not.toMatch(/deductionsDetail\[["']insurance_relief["']\]/);
  });
});
