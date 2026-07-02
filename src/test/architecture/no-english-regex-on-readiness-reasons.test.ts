/**
 * Wave 3 guard rail.
 *
 * Payroll UI must NOT regex on English reason strings to decide remediation
 * actions. The readiness layer (`payroll_readiness_blockers`) emits
 * `reason_code` + `remediation_label` + `remediation_link` — UI components
 * must consume those structured fields directly.
 *
 * One controlled exception: `FALLBACK_REASON_ACTIONS` inside
 * `PayrollSetupGuideDialog.tsx`. That regex only applies when a caller
 * passes legacy `reasons: string[]` (parsed from raw edge-function error
 * messages that carry no rule code). When `blockers` are passed, the regex
 * is never invoked.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");
const SCAN_DIRS = [
  "components/payroll",
  "pages/hr",
  "hooks/payroll",
];

// Pattern that finds the kind of regex-on-English-statutory-names we are
// killing (PAYE, NSSF, SHIF, NHIF, NITA, HELB, KRA inside a RegExp literal,
// or generic "localization|locale|country|pack" classifiers).
const FORBIDDEN = [
  /\/[^\/\n]*\b(PAYE|NSSF|SHIF|NHIF|NITA|HELB|KRA)\b[^\/\n]*\/[a-z]*/i,
  /\/[^\/\n]*\blocalization\|locale\|country\|pack\b[^\/\n]*\/[a-z]*/i,
];

const ALLOWED_FILES = new Set([
  // Controlled fallback for raw edge-function error strings.
  "src/components/payroll/PayrollSetupGuideDialog.tsx",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("Wave 3 — no English regex on readiness reasons", () => {
  it("payroll UI uses structured remediation, not regex matching", () => {
    const offenders: string[] = [];
    for (const sub of SCAN_DIRS) {
      const dir = join(ROOT, sub);
      try {
        for (const file of walk(dir)) {
          const rel = file.replace(`${process.cwd()}/`, "");
          if (ALLOWED_FILES.has(rel)) continue;
          const src = readFileSync(file, "utf8");
          for (const re of FORBIDDEN) {
            if (re.test(src)) {
              offenders.push(`${rel}: matched ${re}`);
              break;
            }
          }
        }
      } catch { /* directory may not exist in some checkouts */ }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
