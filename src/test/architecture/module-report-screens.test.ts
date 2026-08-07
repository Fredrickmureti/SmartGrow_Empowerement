/**
 * Phase 4 — module-native report screens obey the reporting contract too.
 *
 * `reports-single-engine.test.ts` only guards `src/pages/reports/`. The
 * report screens that live inside modules (POS, HR, attendance, admin,
 * projects, payroll legal orders …) were exempt, which is how
 * `HRReports.tsx` shipped a screen showing 10 rows while its export shipped
 * a hand-written summary, and how `Reports.tsx` exported only the first ten
 * expense categories under a total computed from all of them.
 *
 * Two invariants are enforced here:
 *
 *  1. Exports go through `ReportExportService` (via `ReportExportButtons` /
 *     `ExportConfig`). No screen hand-rolls a CSV Blob or an XLSX writer.
 *  2. An export config never truncates its rows. Whatever the screen
 *     totals, the export must enumerate — a `.slice(0, N)` inside an
 *     export-config builder is the exact defect this phase removed.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/** Report screens that live outside `src/pages/reports/`. */
const MODULE_REPORT_SCREENS = [
  "src/pages/Reports.tsx",
  "src/pages/admin/AdminReports.tsx",
  "src/pages/hr/HRReports.tsx",
  "src/pages/hr/AttendanceReports.tsx",
  "src/pages/hr/talent/LearningReportsPage.tsx",
  "src/pages/hr/payroll/LegalOrdersReports.tsx",
  "src/pages/pos/POSReports.tsx",
  "src/pages/pos/CardSettlementReport.tsx",
  "src/pages/projects/portfolio/Reports.tsx",
  "src/pages/timesheets/TimesheetReports.tsx",
];

function read(rel: string): string | null {
  const full = path.join(ROOT, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

const present = MODULE_REPORT_SCREENS.map((f) => [f, read(f)] as const).filter(
  (entry): entry is readonly [string, string] => entry[1] != null,
);

/**
 * Extract the body of every export-config builder in a file: from the
 * declaration of a `*ExportConfig` / `getExportConfig` callback up to the
 * `return {` that yields the config. Row assembly lives in that span.
 */
function exportConfigBodies(src: string): string[] {
  const bodies: string[] = [];
  const re = /(?:const|function)\s+\w*[eE]xportConfig\w*\b/g;
  for (const match of src.matchAll(re)) {
    const start = match.index ?? 0;
    const end = src.indexOf("\n  };", start);
    bodies.push(src.slice(start, end === -1 ? Math.min(start + 4000, src.length) : end));
  }
  return bodies;
}

describe("module-native report screens follow the reporting contract", () => {
  it("finds the module report screens (guard is actually running)", () => {
    expect(present.length).toBeGreaterThan(5);
  });

  it("no module report screen hand-rolls a CSV or XLSX writer", () => {
    const offenders = present
      .filter(([, src]) =>
        /new Blob\(\s*\[[^\]]*csv/i.test(src) ||
        /\bXLSX\.(utils|writeFile|write)\b/.test(src) ||
        /text\/csv/.test(src),
      )
      .map(([f]) => f);
    expect(
      offenders,
      "Export through ReportExportButtons / ReportExportService so CSV, XLSX and PDF " +
        "share one formatting policy",
    ).toEqual([]);
  });

  it("no export config truncates its rows", () => {
    const offenders: string[] = [];
    for (const [file, src] of present) {
      for (const body of exportConfigBodies(src)) {
        // `.slice(0, 10)` on an ISO date string is fine; on a row array it
        // silently ships a partial report under a full-population total.
        const hits = [...body.matchAll(/(\w+)\.slice\(\s*0\s*,\s*\d+\s*\)/g)].filter(
          (m) => !/date|iso|year|start|end|month|str/i.test(m[1]),
        );
        if (hits.length) offenders.push(`${file}: ${hits.map((h) => h[0]).join(", ")}`);
      }
    }
    expect(
      offenders,
      "An export must enumerate every row the screen totals — drop the slice",
    ).toEqual([]);
  });
});
