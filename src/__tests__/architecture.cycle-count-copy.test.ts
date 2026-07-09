/**
 * Architecture guard — Cycle Counting page must speak business English.
 *
 * The prior version of `CycleCountSchedules.tsx` leaked developer
 * identifiers (table names, RPC names, column names, "pg_cron") into
 * user-facing copy. This test locks in the rewrite.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/pages/inventory/CycleCountSchedules.tsx"),
  "utf8",
);

// Extract JSX text nodes and string-literal props that end up rendered.
// Anything inside `""`, `''`, or `>text<` is fair game; anything inside
// identifiers, imports, hooks, RPC arguments (.rpc("name")), .from("t"),
// or queryKey arrays is code and exempt.
function userFacingText(src: string): string {
  // Strip imports.
  let s = src.replace(/^import[^;]+;$/gm, "");
  // Strip queryKey arrays (contain internal names).
  s = s.replace(/queryKey:\s*\[[^\]]*\]/g, "");
  // Strip .rpc("...") arg.
  s = s.replace(/\.rpc\([^)]*\)/g, "");
  // Strip .from("...") arg.
  s = s.replace(/\.from\([^)]*\)/g, "");
  // Strip .eq/.order/.select args (column names).
  s = s.replace(/\.(eq|order|select)\([^)]*\)/g, "");
  // Strip TS interface bodies (identifier fields).
  s = s.replace(/interface\s+\w+\s*\{[^}]*\}/g, "");
  // Strip type/const record objects mapping identifier keys → labels.
  // Keep the label values on the right of `:`.
  return s;
}

const CLEAN = userFacingText(SRC);

const FORBIDDEN = [
  "physical_counts",
  "physical-counts",
  "physical-count",
  "generate_due_cycle_counts",
  "pg_cron",
  "next_run_at",
  "last_run_at",
  "auto_freeze",
  "scope_type",
  "abc_class",
  "tolerance_pct",
  "tolerance_value",
  "cadence",
];

describe("Cycle Counting page copy", () => {
  for (const token of FORBIDDEN) {
    it(`does not expose the identifier "${token}" in user-facing copy`, () => {
      // Look for the token appearing inside a string literal or JSX text.
      // Rough heuristic: it must be surrounded by letters (not `.foo_bar`
      // property access on `s.` variables, which is code, not copy).
      const patterns = [
        new RegExp(`"[^"]*\\b${token}\\b[^"]*"`),
        new RegExp(`'[^']*\\b${token}\\b[^']*'`),
        new RegExp(`>[^<]*\\b${token}\\b[^<]*<`),
        new RegExp(`\`[^\`]*\\b${token}\\b[^\`]*\``),
      ];
      for (const p of patterns) {
        expect(CLEAN, `Found forbidden identifier "${token}" in user-facing copy (pattern ${p})`).not.toMatch(p);
      }
    });
  }

  it("explains what cycle counting means in the sheet description", () => {
    expect(SRC).toMatch(/cycle counting means/i);
  });

  it("uses human labels for cadence", () => {
    expect(SRC).toMatch(/Every week/);
    expect(SRC).toMatch(/Every quarter/);
  });

  it("uses human labels for scope", () => {
    expect(SRC).toMatch(/The entire warehouse/);
    expect(SRC).toMatch(/A hand-picked product list/);
  });
});
