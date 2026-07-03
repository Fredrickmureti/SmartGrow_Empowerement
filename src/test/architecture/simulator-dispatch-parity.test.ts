/**
 * Guard test — the statutory rule simulator's dispatch table MUST cover
 * every computation_method the production engine dispatches on.
 *
 * The RuleSimulator (authoring-time preview) reads
 * `ENGINE_METHOD_TO_KIND` to map a `computation_method` value onto its
 * internal simulation branch. If the engine adds a new method (e.g. via
 * a switch case in `computeOneRule`) and the simulator table is not
 * updated, admins get a "not supported by the simulator" warning while
 * production silently produces payslips — the exact drift Phase 2 aims
 * to eliminate.
 *
 * We parse the switch cases in compute-payroll/index.ts and assert each
 * one is a key in ENGINE_METHOD_TO_KIND.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_METHOD_TO_KIND } from "@/features/localization/lib/ruleSimulator";
import { COMPUTATION_METHOD_LIST } from "@/lib/payroll/computationMethods";

const enginePath = join(process.cwd(), "supabase/functions/compute-payroll/index.ts");
const engineSrc = readFileSync(enginePath, "utf8");

/** Extract `case "<method>":` values inside the computeOneRule switch. */
function extractEngineCases(): string[] {
  const cases = new Set<string>();
  const re = /case\s+["']([a-z_]+)["']\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(engineSrc)) !== null) {
    const key = m[1];
    // Only accept keys that look like statutory computation methods,
    // not incidental switch cases elsewhere in the file.
    if (
      /^(bracket_|tiered_|percentage_|graduated_|flat_|per_employee_|fixed$|pension$)/.test(
        key,
      )
    ) {
      cases.add(key);
    }
  }
  return [...cases];
}

describe("statutory-rule simulator dispatch parity", () => {
  it("every engine switch-case is present in ENGINE_METHOD_TO_KIND", () => {
    const engineCases = extractEngineCases();
    expect(engineCases.length).toBeGreaterThan(0);
    const missing = engineCases.filter((c) => !(c in ENGINE_METHOD_TO_KIND));
    expect(
      missing,
      `The compute-payroll engine dispatches these computation_method values ` +
        `that the RuleSimulator does not know about: ${missing.join(", ")}. ` +
        `Add them to ENGINE_METHOD_TO_KIND in src/features/localization/lib/ruleSimulator.ts ` +
        `so authoring-time previews cannot silently disagree with production.`,
    ).toEqual([]);
  });

  it("every UI-declared computation method is present in ENGINE_METHOD_TO_KIND", () => {
    const missing = COMPUTATION_METHOD_LIST.map((s) => s.method).filter(
      (m) => !(m in ENGINE_METHOD_TO_KIND),
    );
    expect(
      missing,
      `computationMethods.ts advertises these methods that the simulator ` +
        `cannot dispatch: ${missing.join(", ")}. Add mappings to ENGINE_METHOD_TO_KIND.`,
    ).toEqual([]);
  });
});
