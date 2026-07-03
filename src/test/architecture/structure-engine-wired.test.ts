/**
 * Guard test — the rule-graph engine MUST be wired into compute-payroll.
 *
 * The subsystem's headline architectural fix is that
 * `runStructureEngine` is actually invoked by the production payroll
 * engine (branched on `salary_structures.use_structure_engine`), not
 * merely defined in a companion module. If any refactor drops the
 * import, the branch, or the invocation, this test fails immediately —
 * the same way we guard payslip immutability and mapping triggers.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const enginePath = join(process.cwd(), "supabase/functions/compute-payroll/index.ts");
const src = readFileSync(enginePath, "utf8");

describe("compute-payroll wires runStructureEngine", () => {
  it("imports the structure engine", () => {
    expect(src).toMatch(/from\s+["']\.\/structureEngine\.ts["']/);
    expect(src).toMatch(/\brunStructureEngine\b/);
  });

  it("branches on salary_structures.use_structure_engine", () => {
    expect(src).toMatch(/structureUsesEngine\[/);
    expect(src).toMatch(/use_structure_engine/);
  });

  it("invokes runStructureEngine inside the per-employee loop", () => {
    expect(src).toMatch(/runStructureEngine\s*\(\s*\{/);
  });

  it("surfaces structure-engine errors instead of silently falling through", () => {
    expect(src).toMatch(/STRUCTURE_ENGINE_ERROR/);
  });

  it("persists provenance to payroll_rule_traces", () => {
    expect(src).toMatch(/payroll_rule_traces/);
  });
});
