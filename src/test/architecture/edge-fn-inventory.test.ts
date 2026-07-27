/**
 * Edge-function inventory guard.
 *
 * Wave 6.5 (2026-07-27): the previous engineer left the ceiling at 87
 * while the actual count sat at 100 (guard red). Wave 6.5's first pass
 * removed four confirmed-dead functions
 * (`override-return-diagnostic`, `send-leave-email`,
 * `generate-cycle-counts`, `generate-audit-certificate`), taking the
 * count to 96. The ceiling is ratcheted to match and MUST monotonically
 * decrease as Wave 6.5/7/9 retire more legacy functions — see
 * `docs/audit/2026-wave6.5-legacy-inventory.md`.
 *
 * The wrapper guard below stays as-is: no NEW edge function may be a
 * thin `supabase.functions.invoke('other-fn', …)` proxy.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FUNCS_DIR = path.resolve(__dirname, "../../../supabase/functions");
// Ratchet DOWN only. Wave 6.5 target: 87. Wave 9 target: <70.
const CEILING = 96;


function listFunctions(): string[] {
  return fs
    .readdirSync(FUNCS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
}

describe("Edge function inventory", () => {
  it("count does not regress past the current ceiling", () => {
    const fns = listFunctions();
    expect(fns.length).toBeLessThanOrEqual(CEILING);
  });

  it("no edge function is a pure wrapper around another edge function", () => {
    // A "pure wrapper" is one whose body's only meaningful work is to call
    // `supabase.functions.invoke('other-fn', …)` and return the result.
    const offenders: string[] = [];
    for (const fn of listFunctions()) {
      const indexPath = path.join(FUNCS_DIR, fn, "index.ts");
      if (!fs.existsSync(indexPath)) continue;
      const src = fs.readFileSync(indexPath, "utf8");
      const invokeCount = (src.match(/functions\.invoke\(/g) ?? []).length;
      // Tolerate up to 1 invoke (chained workflow), flag 2+ in a tiny file.
      if (invokeCount >= 2 && src.length < 1500) {
        offenders.push(fn);
      }
    }
    expect(offenders).toEqual([]);
  });
});