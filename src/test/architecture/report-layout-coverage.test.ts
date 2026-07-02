/**
 * Phase B0.1 — Report page layout/logger coverage guard.
 *
 * The `report_views` access log is the audit trail finance teams rely on to
 * answer "who viewed payroll last quarter". It only fires from two places:
 *   1. `ReportPageLayout` (covers every report that wraps itself in the
 *      shared layout — the default and recommended path).
 *   2. An explicit `useReportViewLogger()` call (escape hatch for pages
 *      that intentionally render a custom shell, e.g. the Report Center
 *      index itself).
 *
 * A new report page that forgets BOTH would render fine but silently drop
 * out of the audit log. This test fails the build the moment that happens.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const REPORTS_DIR = join(REPO_ROOT, "src/pages/reports");

/**
 * Pages that legitimately bypass the layout + logger pair. Each entry must
 * be justified — drift in this list IS the bug class the test catches.
 */
const EXEMPT: Record<string, string> = {
  // Consolidation is a composite shell that hosts child reports; each
  // child IS wrapped in ReportPageLayout and logs itself. Logging the
  // shell would double-count every drill-down view.
  "Consolidation.tsx": "Composite shell; child reports log themselves.",
};

describe("report pages must wire access logging", () => {
  const files = existsSync(REPORTS_DIR)
    ? readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".tsx"))
    : [];

  it("src/pages/reports/ contains report pages", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} uses ReportPageLayout or useReportViewLogger`, () => {
      const src = readFileSync(join(REPORTS_DIR, file), "utf8");
      const hasLayout = /ReportPageLayout/.test(src);
      const hasLogger = /useReportViewLogger/.test(src);
      const exempt = Object.prototype.hasOwnProperty.call(EXEMPT, file);

      if (exempt) {
        // Don't let an exempt file silently pick up the layout and sit on
        // the exempt list forever (cargo-culted forgiveness).
        expect(
          hasLayout || hasLogger,
          `${file} is in the EXEMPT list but now uses ReportPageLayout/useReportViewLogger — remove the exemption.`,
        ).toBe(false);
        return;
      }

      expect(
        hasLayout || hasLogger,
        `${file} does NOT import ReportPageLayout or useReportViewLogger, so opening it will not be recorded in report_views. ` +
          `Wrap the page in <ReportPageLayout> (preferred), or call useReportViewLogger("<reportId>") explicitly. ` +
          `If you genuinely need to bypass logging, add the file to the EXEMPT map in this test with a one-line rationale.`,
      ).toBe(true);
    });
  }
});
