/**
 * Phase 4 P1.2 — architecture guard for legacy country-typed columns on
 * public.payslips.
 *
 * P1.2d dropped these columns from the schema entirely. Any new code
 * that tries to project them from `public.payslips` would also fail at
 * runtime, but this guard fires first (and explains why), and prevents
 * reintroduction via a re-add migration sneaking back in alongside a
 * code change.
 *
 * The test only inspects source under `src/` and `supabase/`; tests and
 * generated types (`src/integrations/supabase/types.ts`) are excluded
 * because they reflect schema, not consumer intent.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "supabase/functions"];
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".next", "coverage", "__tests__", "tests",
]);
const SKIP_FILES = new Set([
  "src/integrations/supabase/types.ts",
  "src/test/architecture/payslip-legacy-columns.test.ts",
]);

// Files allowed to mention the legacy columns today. P1.2d dropped the
// columns from the schema; P1.2e replaced the last hardcoded UI
// (`VariableEarningsInput`) with pack-driven dynamic columns. The
// allowlist is now empty — any reintroduction is a regression.
const ALLOWLIST = new Set<string>([]);

// Full set of legacy Kenya-typed columns that lived on public.payslips
// before P1.2d. Any `.from("payslips").select(...)` projection that
// mentions these tokens is a reintroduction attempt.
const LEGACY_COLUMNS = [
  "basic_salary", "housing_allowance", "transport_allowance",
  "overtime_pay", "bonus",
  "paye", "nhif", "nssf_employee", "nssf_employer", "housing_levy",
  "personal_relief", "insurance_relief",
  "other_earnings", "other_deductions",
] as const;



function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find every `.from("payslips")` … `.select("...")` projection in the
 * file (across newlines / chained calls) and report any that mention a
 * deprecated column. This catches the architectural signal — what SQL
 * we project from the `payslips` table — without false positives from
 * string literals, comments, regex patterns, or report-output keys
 * that happen to share a name with a deprecated column.
 */
function offendingProjections(content: string): string[] {
  const hits: string[] = [];
  // Match `.from("payslips")` followed (within ~800 chars of chained
  // builder calls) by `.select("...")`. Captures the select argument.
  const re = /\.from\(\s*["']payslips["']\s*\)[\s\S]{0,800}?\.select\(\s*(["'`])([\s\S]*?)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const selectArg = m[2];
    for (const col of LEGACY_COLUMNS) {
      const colRe = new RegExp(`\\b${col}\\b`);
      if (colRe.test(selectArg)) hits.push(col);
    }
  }
  return hits;
}

describe("Phase 4 P1.2 — legacy payslip columns are not introduced in new code", () => {
  it("only allow-listed files project deprecated Kenya-typed columns from public.payslips", () => {
    const offenders: Array<{ file: string; column: string }> = [];
    for (const dir of SCAN_DIRS) {
      const abs = join(ROOT, dir);
      try { statSync(abs); } catch { continue; }
      for (const file of walk(abs)) {
        const rel = relative(ROOT, file).replace(/\\/g, "/");
        if (SKIP_FILES.has(rel)) continue;
        if (/\.test\.[tj]sx?$/.test(rel)) continue;
        if (ALLOWLIST.has(rel)) continue;
        const content = readFileSync(file, "utf8");
        for (const col of offendingProjections(content)) {
          offenders.push({ file: rel, column: col });
        }
      }
    }

    if (offenders.length) {
      const lines = offenders.map((o) => `  - ${o.file}  (legacy column: ${o.column})`).join("\n");
      throw new Error(
        `New code is projecting deprecated country-typed columns from public.payslips.\n` +
        `Migrate to aggregating payslip_lines by category / rule_code, or use\n` +
        `public.payslips_with_aggregates as a short-term shim. Offenders:\n${lines}\n\n` +
        `If you genuinely need to keep a legacy reader for a finite migration\n` +
        `window, add the file to ALLOWLIST in this test with a comment that\n` +
        `names the follow-on slice that will remove it.`,
      );
    }

    expect(offenders).toEqual([]);
  });
});

