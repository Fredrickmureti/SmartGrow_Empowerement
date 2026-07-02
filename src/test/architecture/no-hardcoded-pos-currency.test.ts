/**
 * Architecture guard — POS components/pages must never hardcode the `$`
 * glyph in front of an amount. All currency rendering must flow through
 * the canonical `useCurrency().formatCurrency()` helper, which resolves
 * from `currentBusiness.base_currency`.
 *
 * Pattern caught: `${expr.toFixed(...)}` and `-${expr.toFixed(...)}`
 * inside JSX/template strings.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const SCOPES = ["src/components/pos", "src/pages/pos"];

// Catches `${expr.toFixed(2)}` — a literal `$` glued to a 2-decimal
// numeric formatter (the universal currency convention). Percentages use
// `.toFixed(0)` / `.toFixed(1)` and are intentionally not flagged.
const FORBIDDEN = /-?\$\{?[A-Za-z0-9_.()\s+\-*/]*\.toFixed\(\s*2\s*\)/;

const ALLOWLIST = new Set<string>(
  [
    // This file contains the pattern as a literal regex.
    "src/test/architecture/no-hardcoded-pos-currency.test.ts",
    // Hardware customer-display fallback: the line already prefixes the
    // resolved `currencyCode` before the amount inside a try/catch fallback
    // for environments where Intl.NumberFormat throws. Not a hardcoded `$`.
    "src/pages/pos/CustomerDisplay.tsx",
  ].map((p) => p.split("/").join(sep)),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

describe("architecture: no hardcoded $ in POS", () => {
  for (const scope of SCOPES) {
    it(`${scope} routes all currency rendering through useCurrency()`, () => {
      const files = walk(scope);
      const offenders: string[] = [];
      for (const f of files) {
        if (ALLOWLIST.has(f)) continue;
        const src = readFileSync(f, "utf8");
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (!FORBIDDEN.test(ln)) continue;
          offenders.push(`${toPosix(f)}:${i + 1}  ${ln.trim()}`);
        }
      }
      expect(
        offenders,
        `POS currency rendering must use useCurrency().formatCurrency() — ` +
          `never hardcode \`$\` in front of \`.toFixed(...)\`.\n` +
          `Offenders:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});