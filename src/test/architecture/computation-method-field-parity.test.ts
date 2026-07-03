/**
 * Guard test — every UI-declared computation-method field MUST be
 * consumed by the compute-payroll engine.
 *
 * The Statutory Rule editor writes `parameters` shaped by
 * `src/lib/payroll/computationMethods.ts`. If the editor advertises a
 * field the engine never reads (e.g. it was renamed on one side only),
 * the payroll run silently ignores admin input — one of the highest-risk
 * classes of Payroll bug.
 *
 * This test greps the compiled engine source for every scalar and array
 * column key declared per method and fails if any key is unreferenced.
 * Aliases the engine tolerates (e.g. `cap` ↔ `ceiling`) must appear
 * somewhere in that source string — a plain-text mention is enough.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTATION_METHOD_LIST } from "@/lib/payroll/computationMethods";

const enginePath = join(process.cwd(), "supabase/functions/compute-payroll/index.ts");
const engineSrc = readFileSync(enginePath, "utf8");

// Universal fields declared once and prepended to every method — the
// engine reads them at the outer dispatcher, not per-method. Excluded
// from the per-method grep so we don't flag them as "unused".
const UNIVERSAL_KEYS = new Set(["period", "currency", "notes"]);

describe("computation-method field parity with compute-payroll engine", () => {
  for (const spec of COMPUTATION_METHOD_LIST) {
    it(`${spec.method}: every declared field is referenced by the engine`, () => {
      const declared = new Set<string>();
      for (const f of spec.scalarFields) if (!UNIVERSAL_KEYS.has(f.key)) declared.add(f.key);
      if (spec.arrayField) {
        declared.add(spec.arrayField.key);
        for (const c of spec.arrayField.columns) declared.add(c.key);
      }
      const missing: string[] = [];
      for (const key of declared) {
        // Word-boundary grep — the engine may read via .key, ['key'], or "key".
        const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (!re.test(engineSrc)) missing.push(key);
      }
      expect(
        missing,
        `computation method '${spec.method}' declares fields the engine never reads: ${missing.join(", ")}. ` +
          `Either wire them into supabase/functions/compute-payroll/index.ts, ` +
          `remove them from computationMethods.ts, or add an alias.`,
      ).toEqual([]);
    });
  }
});
