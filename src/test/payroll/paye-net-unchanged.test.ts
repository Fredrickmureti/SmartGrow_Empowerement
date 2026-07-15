/**
 * ADR-0062 addendum — parent tax line unchanged after relief surfacing.
 *
 * Reliefs are informational-only additions to payslip_lines. The parent
 * `paye` (bracket_progressive) line MUST continue to carry the
 * post-relief final tax as its `employee_amount`. This static guard
 * pins that contract by inspecting the engine source rather than
 * booting the runtime, so it catches regressions before deploy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENGINE_SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/compute-payroll/index.ts"),
  "utf8",
);

describe("PAYE line unchanged by relief surfacing", () => {
  it("parent tax line still pushes the deductionsDetail amount", () => {
    // The parent tax pushLine remains keyed off the deductionsDetail
    // amount (post-relief final_tax as computed by the bracket engine).
    expect(ENGINE_SRC).toMatch(
      /pushLine\(code, cat, ruleName, Number\(amt\), 0, false, statRule\?\.rule_type \|\| ruleName, lineSource, statRule\?\.id \?\? null, ref\);/,
    );
  });

  it("relief pushes come AFTER the parent tax pushLine, not before", () => {
    const parent = ENGINE_SRC.indexOf(
      `pushLine(code, cat, ruleName, Number(amt), 0, false, statRule?.rule_type`,
    );
    const relief = ENGINE_SRC.indexOf(`if (personalRelief > 0)`);
    expect(parent).toBeGreaterThan(0);
    expect(relief).toBeGreaterThan(parent);
  });

  it("relief lines never overwrite deductionsDetail", () => {
    // Grep-guard: no assignment into deductionsDetail after the relief block.
    const reliefBlockStart = ENGINE_SRC.indexOf(`if (personalRelief > 0)`);
    const reliefBlockEnd = ENGINE_SRC.indexOf(`}\n      }`, reliefBlockStart);
    expect(reliefBlockEnd).toBeGreaterThan(reliefBlockStart);
    const window = ENGINE_SRC.slice(reliefBlockStart, reliefBlockEnd);
    expect(window).not.toMatch(/deductionsDetail\s*\[/);
    expect(window).not.toMatch(/deductionsDetail\s*=/);
  });
});
