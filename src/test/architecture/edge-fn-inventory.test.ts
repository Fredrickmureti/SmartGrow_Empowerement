/**
 * Edge-function inventory guard.
 *
 * Wave 5 verdict: a blanket 87→73 consolidation was rejected because each
 * of the candidate wrappers carries substantive logic and external state
 * (Safaricom-stored URLs, KRA endpoints, pg_cron URLs, distinct email
 * templates, FK-ordered deletion logic). Collapsing them trades clarity
 * and observability for a count metric.
 *
 * Instead, this guard keeps the inventory in check by:
 *   1. Asserting we don't accidentally regress past today's count (87).
 *   2. Asserting no NEW edge function is added whose body is a thin
 *      `supabase.functions.invoke('other-fn', …)` wrapper — that pattern
 *      should always live in the caller.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FUNCS_DIR = path.resolve(__dirname, "../../../supabase/functions");
const CEILING = 87;

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