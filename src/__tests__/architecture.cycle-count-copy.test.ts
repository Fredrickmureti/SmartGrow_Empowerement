/**
 * Architecture guard — Cycle Counting page must speak business English.
 *
 * The prior version leaked developer identifiers (table names, RPC
 * names, column names, "pg_cron") into user-facing copy. This test
 * scans only the *rendered* surface (JSX text between tags, and
 * copy-carrying string props like title/description/placeholder/
 * aria-label) and asserts none of those identifiers appear.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(process.cwd(), "src/pages/inventory/CycleCountSchedules.tsx"),
  "utf8",
);

// 1. All JSX text nodes (between `>` and `<`, excluding tag boundaries).
const jsxText: string[] = [];
{
  const rx = />([^<>{}\n][^<>{}]*)</g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(SRC))) jsxText.push(m[1]);
}

// 2. String literals passed to copy-carrying JSX props.
const propStrings: string[] = [];
{
  const props = ["title", "description", "placeholder", "aria-label", "label"];
  for (const p of props) {
    const rx = new RegExp(`\\b${p}=\\{?\`([^\`]+)\`\\}?|\\b${p}="([^"]+)"|\\b${p}='([^']+)'`, "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(SRC))) propStrings.push(m[1] || m[2] || m[3]);
  }
}

// 3. toast({ title/description: "..." }) calls — those are user copy too.
{
  const rx = /(title|description):\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)')/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(SRC))) propStrings.push(m[2] || m[3] || m[4]);
}

const RENDERED = [...jsxText, ...propStrings].join(" \n ");

const FORBIDDEN = [
  "physical_counts",
  "generate_due_cycle_counts",
  "pg_cron",
  "next_run_at",
  "last_run_at",
  "auto_freeze",
  "scope_type",
  "abc_class",
  "tolerance_pct",
  "tolerance_value",
  // "cadence" — allowed as English word? No, we replaced it with "How often".
  "cadence",
];

describe("Cycle Counting page copy", () => {
  for (const token of FORBIDDEN) {
    it(`does not expose "${token}" in user-facing copy`, () => {
      const rx = new RegExp(`\\b${token}\\b`);
      expect(RENDERED, `Rendered copy contains forbidden identifier "${token}"`).not.toMatch(rx);
    });
  }

  it("explains what cycle counting means in the sheet description", () => {
    expect(RENDERED).toMatch(/cycle counting means/i);
  });

  it("uses human labels for cadence", () => {
    expect(RENDERED).toMatch(/Every week/);
    expect(RENDERED).toMatch(/Every quarter/);
  });

  it("uses human labels for scope", () => {
    expect(RENDERED).toMatch(/The entire warehouse/);
    expect(RENDERED).toMatch(/A hand-picked product list/);
  });
});
