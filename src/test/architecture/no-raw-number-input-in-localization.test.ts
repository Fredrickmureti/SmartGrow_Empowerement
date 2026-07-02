/**
 * R15.2 — guardrail: no `<Input type="number">` may exist inside the
 * localization editor or payroll configuration surfaces. They MUST use the
 * `<NumericInput>` primitive, which mirrors typed text locally and never
 * silently locks itself on an invalid keystroke (root cause of the stuck/
 * disabled-field bug reported in the admin pack editor).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "src/features/localization",
  "src/pages/hr/payroll",
];

const ALLOWED = new Set<string>([
  // none — every numeric input in these surfaces should use NumericInput
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

describe("Localization & payroll editors must not use raw <Input type=\"number\">", () => {
  it("contains zero offending lines", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED.has(file)) continue;
        const src = readFileSync(file, "utf8");
        // match `<Input ... type="number"` (allow attributes between tag and type)
        const re = /<Input\b[^>]*\btype\s*=\s*"number"/g;
        const matches = src.match(re);
        if (matches) offenders.push(`${file}: ${matches.length} match(es)`);
      }
    }
    expect(offenders, `Use <NumericInput> instead.\n${offenders.join("\n")}`).toEqual([]);
  });
});
