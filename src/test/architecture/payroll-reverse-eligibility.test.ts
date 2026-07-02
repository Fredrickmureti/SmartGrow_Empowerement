/**
 * Architecture guard — every Reverse-button gate must go through
 * `canReverseRun` from `@/lib/payroll/runLifecycle`. Inline
 * `status === "paid"` / `status === "posted"` checks for reversal
 * visibility re-open the lifecycle bug they were introduced to fix
 * (reversal runs themselves showing a Reverse button).
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("payroll reverse eligibility — single source of truth", () => {
  it("no component gates Reverse on raw status comparisons", () => {
    const out = execSync(
      "rg -n --no-heading 'onReverse' src/components/payroll/PayrollRunList.tsx src/components/payroll/PayrollRunDetailsDialog.tsx || true",
      { encoding: "utf8" },
    );
    // Every line that references onReverse in a gating expression must also
    // mention canReverseRun on the same or adjacent line (we check the full file).
    const list = execSync(
      "cat src/components/payroll/PayrollRunList.tsx src/components/payroll/PayrollRunDetailsDialog.tsx",
      { encoding: "utf8" },
    );
    expect(list).toContain("canReverseRun");
    // No remaining `status === "paid"` / `status === "posted"` adjacent to onReverse.
    const offenders = out
      .split("\n")
      .filter((l) => /status\s*===\s*["'](paid|posted)["']/.test(l));
    expect(
      offenders,
      `Reverse-button gates must use canReverseRun(). Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
