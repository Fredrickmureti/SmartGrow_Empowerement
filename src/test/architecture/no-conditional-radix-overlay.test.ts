/**
 * Architecture test: no Radix overlay rendered inside `cond && <Overlay>`.
 *
 * Mirrors the `local/no-conditional-radix-overlay` ESLint rule but runs
 * as part of the architecture suite so CI catches violations even when
 * lint is skipped.
 *
 * See docs/architecture/OVERLAYS.md for the rationale.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const OVERLAY_NAMES = ["Dialog", "Sheet", "AlertDialog", "Drawer"];
// Match `<X` (positive) but NOT `<XContent`, `<XTrigger`, `<XHeader`, etc.
// We only flag the OUTER overlay (which owns the open/close lifecycle), not
// its children which are always conditionally rendered inside.
const PATTERN = new RegExp(
  String.raw`&&\s*\(?\s*<(${OVERLAY_NAMES.join("|")})(?=[\s>])`,
  "g",
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if ([".ts", ".tsx"].includes(extname(p))) out.push(p);
  }
  return out;
}

describe("no conditional Radix overlay", () => {
  it("no `cond && <Dialog/Sheet/AlertDialog/Drawer>` patterns in src/", () => {
    const violations: string[] = [];
    for (const file of walk("src")) {
      // Skip the test files and the lint rule itself.
      if (file.includes("/test/architecture/no-conditional-radix-overlay.test")) continue;
      const src = readFileSync(file, "utf8");
      // Strip line comments to avoid false positives in docs.
      const code = src
        .split("\n")
        .map((line) => {
          if (/OVERLAY-EXEMPT:/.test(line)) return ""; // explicit opt-out
          const idx = line.indexOf("//");
          return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join("\n");
      const matches = code.match(PATTERN);
      if (matches) {
        violations.push(`${file}: ${matches.join(", ")}`);
      }
    }
    expect(
      violations,
      `Found ${violations.length} conditional Radix overlay(s). ` +
        `Always mount overlays and toggle via \`open=\`. See docs/architecture/OVERLAYS.md.\n` +
        violations.join("\n"),
    ).toEqual([]);
  });
});
