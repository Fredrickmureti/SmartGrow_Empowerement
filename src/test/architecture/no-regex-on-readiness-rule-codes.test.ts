/**
 * Architecture guard — Payroll Readiness must consume structured
 * engine output, never reverse-engineer rule codes via regex.
 *
 * The previous implementation matched rule codes with regexes like
 * `/salary|structure/i.test(code)` to populate UI booleans. That
 * silently drifted as new rules were added. Any file in the payroll
 * UI surface that touches readiness data and matches a rule-code-like
 * pattern with regex is a regression of ADR-0040.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "src/pages/hr/payroll",
  "src/components/payroll",
  "src/hooks/payroll",
];

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const BANNED = [
  /\/contract\/i\.test\(/, // legacy rule-code regex
  /\/salary\|structure\/i\.test\(/,
  /\/schedule\/i\.test\(/,
  /\/statutory|identifier\/i\.test\(/,
  /\/bank\/i\.test\(/,
];

describe("payroll readiness: no regex on rule codes", () => {
  it("no payroll surface file matches a rule code with a regex", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue;
      }
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        if (BANNED.some((re) => re.test(src))) offenders.push(file);
      }
    }
    expect(offenders, `Regex-on-rule-code drift in: ${offenders.join(", ")}`).toEqual([]);
  });
});
