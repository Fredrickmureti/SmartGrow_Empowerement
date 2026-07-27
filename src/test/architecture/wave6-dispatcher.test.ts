/**
 * Architecture guards for Wave 6 (print job dispatcher).
 *
 * - `claim_print_jobs` may only be invoked from the drainer edge function.
 *   Any other call site would race the drainer for jobs and violate the
 *   "single drainer" invariant established in the plan §10 spec.
 * - Rows in `print_jobs` may only be INSERTed via the `submit_document_intent`
 *   chokepoint (server-side) or from the drainer's fan-out logic. Direct
 *   `print_jobs` inserts from application code bypass the intent resolver
 *   and would drop dedupe/scenario metadata.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("Wave 6: print job dispatcher invariants", () => {
  it("claim_print_jobs is only called from the drainer edge function", () => {
    const src = walk(join(ROOT, "src"));
    const edge = walk(join(ROOT, "supabase", "functions")).filter(
      (p) => !p.includes(join("dispatch-print-jobs", ""))
    );
    const offenders: string[] = [];
    for (const f of [...src, ...edge]) {
      const body = readFileSync(f, "utf8");
      if (body.includes("claim_print_jobs")) offenders.push(relative(ROOT, f));
    }
    // Allow this guard file + generated Supabase types.
    const filtered = offenders.filter(
      (p) =>
        !p.endsWith("wave6-dispatcher.test.ts") &&
        !p.endsWith("integrations/supabase/types.ts"),
    );
    expect(filtered).toEqual([]);

  });

  it("print_jobs INSERT is confined to submitIntent chokepoint + drainer", () => {
    const src = walk(join(ROOT, "src"));
    const offenders: string[] = [];
    for (const f of src) {
      const body = readFileSync(f, "utf8");
      // .from("print_jobs").insert or .from('print_jobs').insert
      const rx = /\.from\((["'])print_jobs\1\)\s*[\s\S]{0,200}?\.insert\(/;
      if (rx.test(body)) offenders.push(relative(ROOT, f));
    }
    const allowed = new Set<string>([
      "src/services/documents/submitIntent.ts",
    ]);
    const filtered = offenders.filter((p) => !allowed.has(p));
    expect(filtered).toEqual([]);
  });
});
