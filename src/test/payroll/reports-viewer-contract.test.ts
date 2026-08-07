/**
 * Regression test — the Payroll Report viewer MUST tag its ExportConfig
 * with the server-build hints (`reportType`, `dateFrom`, `dateTo`,
 * `businessId`, `filters`) so `ReportPreviewDialog` takes the SERVER-BUILD
 * path in `render-report` instead of the lossy prebuilt path.
 *
 * The prebuilt path re-ships client-projected rows, which for several
 * payroll reports contain null cells because the client `getExportConfig`
 * only knows about column keys returned by the JSON API — computed or
 * `_meta`-scoped fields don't survive the projection. That is what caused
 * the "table shows N rows but Preview PDF is empty" complaint reported
 * across every payroll report. Adding these hints regenerates the dataset
 * on the server from the same reportType + period the table used.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const viewerPath = resolve(
  __dirname,
  "../../pages/hr/payroll/reports/PayrollReportViewer.tsx",
);

describe("PayrollReportViewer ExportConfig contract", () => {
  const src = readFileSync(viewerPath, "utf8");

  it("attaches reportType to the ExportConfig", () => {
    expect(src).toMatch(/reportType:\s*reportKey/);
  });

  it("attaches dateFrom and dateTo to the ExportConfig", () => {
    expect(src).toMatch(/\bdateFrom,\s*\n?\s*dateTo,/);
  });

  it("attaches businessId to the ExportConfig", () => {
    expect(src).toMatch(/businessId:\s*currentBusiness\?\.id/);
  });

  it("attaches filters to the ExportConfig", () => {
    expect(src).toMatch(/filters:\s*\{\s*branchId:/);
  });

  it("does NOT pass companyName from the page (branding is server-owned)", () => {
    expect(src).not.toMatch(/companyName:\s*currentOrg/);
  });
});

/**
 * Phase 7 — the hints above are worthless if only the PDF path uses them.
 * CSV and XLSX must go through the SAME payload builder as the PDF, and
 * that builder must omit client rows/columns in server-build mode (sending
 * them would trip `render-report`'s prebuilt branch and re-introduce the
 * browser's truncated slice).
 */
describe("tabular exports share the PDF's server-build path", () => {
  const service = readFileSync(
    resolve(__dirname, "../../services/reports/ReportExportService.ts"),
    "utf8",
  );

  it("builds the CSV/XLSX payload with the shared builder", () => {
    expect(service).toMatch(
      /fetchReportTabularBlob[\s\S]*?buildRenderPayload\(config, wireFormat\)/,
    );
  });

  it("builds the PDF payload with the same shared builder", () => {
    expect(service).toMatch(/buildRenderPayload\(config, "pdf"\)/);
  });

  it("omits client rows and columns when the server can rebuild the report", () => {
    const serverBranch = service.slice(
      service.indexOf("if (canServerBuild(config))"),
      service.indexOf("return {\n    ...base,\n    columns: config.columns"),
    );
    expect(serverBranch).not.toContain("rows: config.rows");
    expect(serverBranch).not.toContain("columns: config.columns");
    expect(serverBranch).toContain("dateFrom: config.dateFrom");
  });

  it("requires reportType + org + period before taking the server-build path", () => {
    expect(service).toMatch(
      /c\.reportType && c\.organizationId && c\.dateFrom && c\.dateTo/,
    );
  });
});
