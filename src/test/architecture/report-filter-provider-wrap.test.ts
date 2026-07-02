/**
 * Regression test for the `/finance/reports/tax` crash:
 *   "useReportFilters() called outside <ReportFilterProvider>".
 *
 * Any report page that renders <ReportBranchFilter /> or calls
 * useReportFilters() MUST wrap its default export in <ReportFilterProvider>.
 * Otherwise the page crashes the first time a user opens it.
 *
 * This test scans every file under src/pages/reports/ and src/pages/hr/payroll/
 * and asserts the wrap is present when the dependency is.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const ROOTS = ["src/pages/reports", "src/pages/hr/payroll"];

describe("ReportFilterProvider wrap guard", () => {
  const files = ROOTS.flatMap((r) => {
    try { return walk(r); } catch { return []; }
  });

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const usesFilters =
      /useReportFilters\s*\(/.test(src) ||
      /<\s*ReportBranchFilter\b/.test(src);
    if (!usesFilters) continue;

    it(`${file} wraps its default export in <ReportFilterProvider>`, () => {
      expect(src).toMatch(/ReportFilterProvider/);
      // Default export must actually render the provider, not just import it.
      expect(src).toMatch(/<\s*ReportFilterProvider[\s>]/);
    });
  }
});