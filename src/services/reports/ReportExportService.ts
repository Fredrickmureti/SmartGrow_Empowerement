/**
 * Report Export Service
 * 
 * Enterprise-grade export functionality using:
 * - xlsx library for proper Excel files with formatting
 * - In-page print via hidden iframe (no new tab)
 * - Native CSV generation with proper escaping
 */

import * as XLSX from "xlsx";
import { format } from "date-fns";
import { getCachedPdf, cachePdf } from "./pdfCache";

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Strict format union — drives Excel cell typing, CSV serialization,
 * and PDF column alignment. Loose strings would silently break number
 * formatting in spreadsheets (W5 in the reporting audit).
 */
export type ExportColumnFormat = "text" | "currency" | "number" | "date" | "percent";

export interface ExportColumn {
  key: string;
  header: string;
  width?: number;
  format?: ExportColumnFormat;
  align?: "left" | "center" | "right";
}

export interface ExportRow {
  [key: string]: string | number | boolean | null | undefined;
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
  _depth?: number;
}

export interface ExportConfig {
  title: string;
  subtitle?: string;
  dateRange?: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  sheetName?: string;
  /**
   * Multi-currency override. Leave undefined to use the organization's
   * base_currency (resolved server-side from `getOrganizationBranding`).
   */
  currency?: string;
  generatedAt?: Date;
  /**
   * INTERNAL ONLY — populated by `ReportContext.enrichExportConfig`.
   * Pages MUST NOT pass this manually. Branding is injected server-side
   * from the canonical `getOrganizationBranding()` loader so logos and
   * company details cannot drift between modules.
   *
   * Stage C of the reporting closure plan: `companyName` was removed —
   * it was the last vector by which a page could override branding.
   */
  organizationId?: string;
  /**
   * INTERNAL ONLY — for CSV/Excel header rows that need a company-name
   * line. Populated by `ReportContext.enrichExportConfig`. Do NOT set
   * this from a page.
   */
  companyName?: string;
  /**
   * Optional registry key (e.g. "attendance_daily_log"). When set,
   * `render-report` resolves the canonical column spec + format profile
   * + masthead from `_shared/reports/columnSpecs.ts` instead of inferring
   * from the row shape. Pages that already have a registered key SHOULD
   * pass it so the PDF renders identically across modules.
   */
  reportType?: string;
}

// ─── CSV Export ──────────────────────────────────────────────────────

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToCSV(config: ExportConfig): void {
  const lines: string[] = [];
  lines.push(escapeCSV(config.title));
  if (config.companyName) lines.push(escapeCSV(config.companyName));
  if (config.dateRange) lines.push(escapeCSV(config.dateRange));
  lines.push("");
  lines.push(config.columns.map((c) => escapeCSV(c.header)).join(","));

  for (const row of config.rows) {
    const values = config.columns.map((col) => {
      const val = row[col.key];
      if (col.format === "currency" && typeof val === "number") {
        return escapeCSV(val.toFixed(2));
      }
      if (typeof val === "boolean") return escapeCSV(String(val));
      return escapeCSV(val as string | number | null | undefined);
    });
    lines.push(values.join(","));
  }

  lines.push("");
  lines.push(`Generated: ${format(config.generatedAt || new Date(), "yyyy-MM-dd HH:mm:ss")}`);

  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `${sanitizeFilename(config.title)}_${format(new Date(), "yyyy-MM-dd")}.csv`);
}

// ─── Excel Export ────────────────────────────────────────────────────

export function exportToExcel(config: ExportConfig): void {
  const wb = XLSX.utils.book_new();

  const headerData: (string | number)[][] = [];
  headerData.push([config.title]);
  if (config.companyName) headerData.push([config.companyName]);
  if (config.dateRange) headerData.push([config.dateRange]);
  headerData.push([]);
  headerData.push(config.columns.map((c) => c.header));

  const dataRows: (string | number | null)[][] = config.rows.map((row) =>
    config.columns.map((col) => {
      const val = row[col.key];
      if (val === undefined || val === null) return null;
      return val as string | number;
    })
  );

  const footerRows: (string | number)[][] = [
    [],
    [`Generated: ${format(config.generatedAt || new Date(), "yyyy-MM-dd HH:mm:ss")}`],
  ];

  const allRows = [...headerData, ...dataRows, ...footerRows];
  const ws = XLSX.utils.aoa_to_sheet(allRows);

  ws["!cols"] = config.columns.map((col) => ({
    wch: col.width || (col.format === "currency" ? 18 : 20),
  }));

  const headerRowCount = headerData.length;

  for (let colIdx = 0; colIdx < config.columns.length; colIdx++) {
    const col = config.columns[colIdx];
    if (col.format === "currency" || col.format === "number") {
      for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
        const cellRef = XLSX.utils.encode_cell({ r: headerRowCount + rowIdx, c: colIdx });
        const cell = ws[cellRef];
        if (cell && typeof cell.v === "number") {
          cell.z = col.format === "currency" ? "#,##0.00" : "#,##0";
          cell.t = "n";
        }
      }
    }
  }

  const colCount = config.columns.length;
  if (colCount > 1) {
    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
    ];
    if (config.companyName) {
      ws["!merges"].push({ s: { r: 1, c: 0 }, e: { r: 1, c: colCount - 1 } });
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, config.sheetName || "Report");

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, `${sanitizeFilename(config.title)}_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
}

// ─── Print Export (in-page, no new tab) ──────────────────────────────

// exportToPrint has been removed. Use printReportAsPdf() instead.

/**
 * Generates a server-side PDF and prints it in-page (no new tab).
 * Triggers the browser's native print dialog while keeping the user on the current page.
 */
export async function printReportAsPdf(config: ExportConfig): Promise<void> {
  const { printPdfInPage } = await import("@/services/printing/pdfUtils");
  const blob = await fetchReportPdfBlob(config);
  await printPdfInPage(blob);
}

// Legacy getPrintPreviewHTML and buildPrintHTML have been removed.
// Preview now uses the actual server-generated PDF (see PrintPreviewDialog).

// ─── PDF Export (server-side via edge function) ─────────────────────

/**
 * Generates a PDF via the canonical `render-report` edge function and
 * triggers a download in the browser.
 *
 * Stage 2: replaces the legacy `generate-report-pdf` call. Deprecated
 * fields (companyName / currency override / organizationId) are NOT
 * sent on the wire — branding is resolved server-side from
 * `getOrganizationBranding(organizationId)`.
 */
export async function exportToPDF(config: ExportConfig): Promise<void> {
  const blob = await fetchReportPdfBlob(config);
  downloadBlob(blob, `${sanitizeFilename(config.title)}_${format(new Date(), "yyyy-MM-dd")}.pdf`);
}

/**
 * Single source of truth for "give me the PDF blob for this ExportConfig".
 * Used by both download and print paths so caching + payload shape stay
 * identical between them.
 */
/**
 * Public alias for the canonical PDF generator. Used by `EmailReportDialog`
 * so the emailed PDF is byte-identical to the user's "Download as PDF".
 */
export async function generateReportPdfBlob(config: ExportConfig): Promise<Blob> {
  return fetchReportPdfBlob(config);
}

async function fetchReportPdfBlob(config: ExportConfig): Promise<Blob> {
  const { supabase } = await import("@/integrations/supabase/client");

  // Wire payload: strict, no deprecated fields. The edge function pulls
  // company name / currency / branding from the organization row.
  const payload = {
    title: config.title,
    subtitle: config.subtitle,
    dateRange: config.dateRange,
    columns: config.columns,
    rows: config.rows,
    orientation: "landscape" as const,
    organizationId: config.organizationId,
    reportType: config.reportType,
    // Currency is still allowed as an explicit override (multi-currency
    // reports). Org base_currency is the fallback when omitted.
    currency: config.currency,
  };

  const cached = getCachedPdf(payload);
  if (cached) return cached;

  const { data, error } = await supabase.functions.invoke("render-report", {
    body: payload,
    headers: { "Content-Type": "application/json" },
  });
  if (error) throw error;

  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
  cachePdf(payload, blob);
  return blob;
}

// ─── Utilities ───────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
}
