/**
 * The reporting engine is the only way to render a report.
 *
 * Before consolidation, all 19 report pages hand-rolled shadcn `<Table>`
 * markup plus a local `fmt` / `fmtOrDash`, so column alignment, negative
 * numbers, empty cells, sticky headers and long-report behaviour differed
 * page by page — and none of them matched the PDF the same page exported.
 * These guards keep that from growing back: report pages declare columns
 * and rows, and `@/design-system/reports` decides how a report looks.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPORT_PAGES_DIR = path.resolve(process.cwd(), "src/pages/reports");

/**
 * Pages that compose other Card-based components and render no data table
 * of their own. They are allowed to skip the engine because they have
 * nothing for it to render. Adding a table to one of these means migrating
 * it and deleting the entry — the list only ever shrinks.
 */
const NO_TABLE_PAGES = new Set([
  "ControlAccountReconciliation.tsx",
  "InventoryGLReconciliation.tsx",
  "ManagementReports.tsx",
]);

const pages = readdirSync(REPORT_PAGES_DIR).filter((f) => f.endsWith(".tsx"));

function read(file: string): string {
  return readFileSync(path.join(REPORT_PAGES_DIR, file), "utf8");
}

describe("reporting engine is the single rendering path", () => {
  it("finds the report pages (guard is actually running)", () => {
    expect(pages.length).toBeGreaterThan(15);
  });

  it("no report page imports raw shadcn table primitives", () => {
    const offenders = pages.filter((f) => /from "@\/components\/ui\/table"/.test(read(f)));
    expect(
      offenders,
      "Render report data through <ReportTable> from @/design-system/reports instead of raw <Table> markup",
    ).toEqual([]);
  });

  it("every table-bearing report page renders through the engine", () => {
    const offenders = pages.filter(
      (f) => !NO_TABLE_PAGES.has(f) && !/@\/design-system\/reports/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });

/**
 * Pages that still call `formatCurrency` for figures OUTSIDE the table —
 * KPI cards and status banners. Their table cells are already engine-
 * formatted. This list is a ratchet: it may shrink, never grow.
 */
const LEGACY_KPI_FORMATTERS = new Set([
  "AgingReport.tsx",
  "BudgetReport.tsx",
  "DepreciationReport.tsx",
  "GeneralLedger.tsx",
  "InventoryValuationReport.tsx",
  "ManagementReports.tsx",
  "PartnerLedger.tsx",
  "SalesReports.tsx",
  "StockAgingReport.tsx",
  "StockReports.tsx",
  "TaxReports.tsx",
]);

  it("no report page formats money outside the engine", () => {
    const offenders = pages.filter((f) => {
      const src = read(f);
      // `formatCurrency` renders "-KES 1,234"; the PDF renders
      // "(KES 1,234.00)". A page that reaches for it puts the two
      // renderings of the same figure back out of agreement.
      if (/fmtOrDash/.test(src)) return true;
      return /formatCurrency\s*\(/.test(src) && !LEGACY_KPI_FORMATTERS.has(f);
    });
    expect(
      offenders,
      "Use a column `format`, or formatAccountingNumber from @/design-system/reports",
    ).toEqual([]);
  });


  it("the masthead comes from ReportSurface, not the legacy header", () => {
    const offenders = pages.filter((f) => /FinancialReportHeader/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
