/**
 * Architecture guard — engines must resolve rules through the shared
 * resolver, never by querying `payroll_statutory_rules` directly.
 *
 * ADR-0010 forbids engine-side hard-coding of rule codes. This guard
 * enforces the corollary: the engine must not even reach for the raw
 * rules table. Any direct `.from("payroll_statutory_rules")` in an
 * engine folder means the engine is picking rules with its own
 * logic — bypassing pack effectivity, tenant overrides, versioning,
 * and precedence resolution that the shared resolver owns.
 *
 * Engines allowed on this floor:
 *   - compute-payroll
 *   - generate-tax-certificate
 *   - generate-statutory-return
 *
 * Escape hatch: a single-line `// RESOLVER-EXEMPT: <reason>` marker
 * on the offending line, mirroring `no-literal-rule-codes-in-engines`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ENGINE_DIRS = [
  "supabase/functions/compute-payroll",
  "supabase/functions/generate-tax-certificate",
  "supabase/functions/generate-statutory-return",
];

const REPO = resolve(__dirname, "../../..");

function collect(dir: string): string[] {
  const abs = join(REPO, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    const st = statSync(p);
    if (st.isDirectory()) continue;
    if (!/\.ts$/.test(name)) continue;
    if (/\.test\.ts$/.test(name)) continue;
    out.push(p);
  }
  return out;
}

describe("engine resolver-only invariant", () => {
  const files = ENGINE_DIRS.flatMap(collect);

  it("finds engine files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no engine file queries payroll_statutory_rules directly", () => {
    const violations: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.from\(\s*["']payroll_statutory_rules["']\s*\)/.test(line)) return;
        if (/RESOLVER-EXEMPT:/.test(line)) return;
        // Allow the marker anywhere in the preceding 8 lines — engine
        // reads are usually wrapped in a multi-line query builder and
        // the annotation is placed above the block for readability.
        const window = lines.slice(Math.max(0, i - 8), i).join("\n");
        if (/RESOLVER-EXEMPT:/.test(window)) return;
        violations.push(`${file.replace(REPO + "/", "")}:${i + 1}`);
      });
    }
    expect(
      violations,
      `Engines must dispatch through the shared resolver, not raw rule reads. Offenders:\n  ${violations.join("\n  ")}\nIf a bypass is truly necessary, add \`// RESOLVER-EXEMPT: <reason>\` on the same line or in the 8 lines above.`,
    ).toEqual([]);
  });

  it("shared token resolver exists as the single substitution point", () => {
    // ADR-0010 mandates a single resolver so editor preview and engine
    // output agree on the ‹unresolved:…› sentinel. This guard locks the
    // module's existence; wiring generate-statutory-return through it
    // is tracked as a P2.a follow-up in ADR-0056 (semantic diff needs
    // the same resolver context).
    const shared = resolve(REPO, "supabase/functions/_shared/renderTokens.ts");
    expect(
      existsSync(shared),
      "supabase/functions/_shared/renderTokens.ts is the ADR-0010 single token resolver — do not delete or rename without an ADR update.",
    ).toBe(true);
  });
});
