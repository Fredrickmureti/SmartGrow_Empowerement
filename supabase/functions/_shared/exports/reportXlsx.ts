/**
 * Milestone C.2 — Report tabular exports (XLSX).
 *
 * Single-source-of-truth server-side XLSX serializer for the same
 * `ReportExportConfig` shape `render-report` consumes for PDF + CSV.
 *
 * Uses the `xlsx` (SheetJS) library — same version pinned by the client
 * bundle so the byte-for-byte output matches what the app previously
 * emitted from `ReportExportService.exportToExcel`. Loaded via esm.sh
 * with Deno target so it works in the edge runtime without native
 * bindings.
 *
 * Applies:
 *   - column widths (falls back to 18 for currency, else 20)
 *   - currency (`#,##0.00`) / number (`#,##0`) formats
 *   - a title cell merged across the column span (plus companyName /
 *     dateRange rows when provided)
 *   - a footer "Generated: <iso>" row
 *
 * Pure `(config) → Uint8Array`. NO DB access.
 */

// deno-lint-ignore-file no-explicit-any
// esm.sh serves a Deno-compatible ESM build of SheetJS.
import * as XLSX from "https://esm.sh/xlsx@0.18.5?target=deno";

import { groupRuns, type ReportExportColumn, type ReportExportConfig } from "./reportCsv.ts";

export function buildReportXlsx(config: ReportExportConfig): Uint8Array {
  const wb = XLSX.utils.book_new();

  const headerRows: (string | number)[][] = [];
  headerRows.push([config.title]);
  if (config.companyName) headerRows.push([config.companyName]);
  if (config.subtitle) headerRows.push([config.subtitle]);
  if (config.dateRange) headerRows.push([config.dateRange]);
  headerRows.push([]);
  // Optional band tier ("Opening balance" merged over its Debit/Credit pair).
  const runs = groupRuns(config.columns);
  const bandRowIndex = runs.length > 0 ? headerRows.length : -1;
  if (runs.length > 0) {
    const band: string[] = [];
    for (const run of runs) {
      band.push(run.label);
      for (let i = 1; i < run.span; i++) band.push("");
    }
    headerRows.push(band);
  }
  headerRows.push(config.columns.map((c) => c.header));


  const dataRows: (string | number | null)[][] = config.rows.map((row) =>
    config.columns.map((col) => {
      const val = row[col.key];
      if (val === undefined || val === null) return null;
      if (typeof val === "boolean") return String(val);
      return val as string | number;
    })
  );

  const footerRows: (string | number)[][] = [
    [],
    [`Generated: ${config.generatedAt ?? new Date().toISOString()}`],
  ];

  const allRows = [...headerRows, ...dataRows, ...footerRows];
  const ws = XLSX.utils.aoa_to_sheet(allRows);

  ws["!cols"] = config.columns.map((col: ReportExportColumn) => ({
    wch: col.width ?? (col.format === "currency" ? 18 : 20),
  }));

  const headerRowCount = headerRows.length;
  for (let colIdx = 0; colIdx < config.columns.length; colIdx++) {
    const col = config.columns[colIdx];
    if (col.format !== "currency" && col.format !== "number") continue;
    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const cellRef = XLSX.utils.encode_cell({ r: headerRowCount + rowIdx, c: colIdx });
      const cell = (ws as any)[cellRef];
      if (cell && typeof cell.v === "number") {
        cell.z = col.format === "currency" ? "#,##0.00" : "#,##0";
        cell.t = "n";
      }
    }
  }

  const colCount = config.columns.length;
  if (colCount > 1) {
    const merges: any[] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
    ];
    let mergeRow = 1;
    if (config.companyName) {
      merges.push({ s: { r: mergeRow, c: 0 }, e: { r: mergeRow, c: colCount - 1 } });
      mergeRow++;
    }
    if (config.subtitle) {
      merges.push({ s: { r: mergeRow, c: 0 }, e: { r: mergeRow, c: colCount - 1 } });
      mergeRow++;
    }
    if (config.dateRange) {
      merges.push({ s: { r: mergeRow, c: 0 }, e: { r: mergeRow, c: colCount - 1 } });
    }
    if (bandRowIndex >= 0) {
      for (const run of runs) {
        if (!run.label || run.span < 2) continue;
        merges.push({
          s: { r: bandRowIndex, c: run.start },
          e: { r: bandRowIndex, c: run.start + run.span - 1 },
        });
      }
    }
    (ws as any)["!merges"] = merges;

  }

  XLSX.utils.book_append_sheet(wb, ws, "Report");

  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Uint8Array(buf);
}

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
