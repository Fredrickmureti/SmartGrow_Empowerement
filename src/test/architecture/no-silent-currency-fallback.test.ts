/**
 * Architecture guard test — fails CI if any production code silently falls
 * back to "USD" (or 'USD') when the active business currency is missing.
 *
 * Currency MUST always be sourced from `currentBusiness.base_currency`.
 * If no business is selected, the operation must throw or refuse to run —
 * silently writing USD into a Kenyan/EU/etc. workspace poisons every
 * downstream FX, AR, AP and revenue report.
 *
 * The codebase enforces this rule at the DB layer (`lock_business_currency_after_je`)
 * and at the helper layer (`requireBusinessId`). This test enforces it at
 * the source level so the rule cannot be re-broken by accident.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const SCOPES = ["src/hooks", "src/components", "src/pages"];

// Pattern catches: `|| "USD"`, `|| 'USD'`, `?? "USD"`, `?? 'USD'`
// (with or without surrounding whitespace).
const FORBIDDEN = /(\|\||\?\?)\s*['"]USD['"]/;

// Files allowed to mention `|| "USD"` for legitimate reasons (test fixtures,
// architecture-test source itself, currency-display fallbacks that never
// touch the books). Every entry must justify itself in a comment.
const ALLOWLIST = new Set<string>(
  [
    // This file scans for the pattern and contains it as a literal.
    "src/test/architecture/no-silent-currency-fallback.test.ts",
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

describe("architecture: no silent USD fallback", () => {
  for (const scope of SCOPES) {
    it(`${scope} contains no \`|| "USD"\` / \`?? "USD"\` fallbacks`, () => {
      const files = walk(scope);
      const offenders: string[] = [];
      for (const f of files) {
        if (ALLOWLIST.has(f)) continue;
        const src = readFileSync(f, "utf8");
        // Per-line scan so we can honor an inline opt-out comment on the
        // SAME line: `// architecture-allow: display-only fallback`.
        // Use this only for read-only display formatters where the historical
        // currency on a record is genuinely unknown — never for writes.
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i];
          if (!FORBIDDEN.test(ln)) continue;
          if (/architecture-allow:\s*display-only\s+fallback/.test(ln)) continue;
          offenders.push(`${toPosix(f)}:${i + 1}`);
        }
      }
      expect(
        offenders,
        `Currency must come from currentBusiness.base_currency with no fallback. ` +
          `For pure display formatters of historical data, append the comment ` +
          `\`// architecture-allow: display-only fallback\` on the same line.\n` +
          `Offenders:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
