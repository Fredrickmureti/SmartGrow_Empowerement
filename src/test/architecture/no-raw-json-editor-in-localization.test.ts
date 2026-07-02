/**
 * R14.5 — product directive: payroll/localization users must never see raw
 * JSON. This test fails if any editor surface binds a `<Textarea>` to
 * `JSON.stringify(...)` or shows a `placeholder="{...}"` (raw-JSON cue).
 *
 * Read-only diff renderers (`PackDiffView.tsx`) are exempt — those legitimately
 * present serialized snapshots for human-readable comparison and never accept
 * input.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ROOTS = [
  "src/features/localization",
  "src/pages/hr/payroll",
  "src/pages/admin",
];

const EXEMPT_FILES = new Set<string>([
  "PackDiffView.tsx",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

describe("No raw-JSON editor surfaces in localization / payroll / admin", () => {
  it("no <Textarea> bound to JSON.stringify(...) or placeholder=\"{...}\"", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (EXEMPT_FILES.has(basename(file))) continue;
        const src = readFileSync(file, "utf8");
        // Heuristic 1: <Textarea ... value={JSON.stringify(
        if (/<Textarea\b[\s\S]{0,400}?JSON\.stringify\(/.test(src)) {
          offenders.push(`${file}: <Textarea> bound to JSON.stringify`);
        }
        // Heuristic 2: placeholder text that starts with `{`, suggesting
        // the user is meant to type raw JSON.
        if (/placeholder\s*=\s*"\{[^"]*"/.test(src)) {
          offenders.push(`${file}: raw-JSON placeholder`);
        }
      }
    }
    expect(offenders, `Use guided form widgets, not raw-JSON editors.\n${offenders.join("\n")}`).toEqual([]);
  });
});
