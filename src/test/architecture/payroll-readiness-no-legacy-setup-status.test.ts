/**
 * Wave 1C architecture guard — payroll modules must not depend on the
 * legacy `app_setup_status` / `useAppSetupStatus` pathway.
 *
 * Background: the previous payroll setup gate consulted `app_setup_status`
 * via `useAppSetupStatus`. That hook fails OPEN when no row exists for the
 * current org, which silently bypassed every front-end payroll gate on a
 * fresh organization. Wave 1A/1B introduced `payroll_readiness_findings`
 * + `payroll_readiness_blockers` as the single source of truth, and Wave 1C
 * locks that in by forbidding payroll-scoped code from importing the legacy
 * helpers ever again.
 *
 * `useAppSetupStatus` itself is still allowed for non-payroll apps; this
 * test only guards code inside payroll module boundaries.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "src/components/payroll",
  "src/pages/hr/payroll",
  "src/hooks/payroll",
  "supabase/functions/compute-payroll",
  "supabase/functions/post-payroll-gl",
];

const FORBIDDEN = [
  /useAppSetupStatus/,
  /\bapp_setup_status\b/,
  /\brefresh_payroll_setup_status\b/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("Wave 1C — payroll modules don't read app_setup_status", () => {
  it("none of the forbidden symbols appear in payroll-scoped source", () => {
    const offending: { file: string; line: number; text: string }[] = [];

    for (const root of ROOTS) {
      const files = walk(join(process.cwd(), root));
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        const lines = src.split("\n");
        lines.forEach((line, i) => {
          const trimmed = line.trimStart();
          // Skip comments — historical notes are fine.
          if (
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("/*")
          ) return;
          for (const pat of FORBIDDEN) {
            if (pat.test(line)) {
              offending.push({ file, line: i + 1, text: line.trim() });
            }
          }
        });
      }
    }

    expect(offending).toEqual([]);
  });
});
