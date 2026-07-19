/**
 * Milestone C.2 — Report tabular exports (CSV).
 *
 * Single-source-of-truth server-side CSV serializer for the shape
 * `render-report` receives in prebuilt + server-build modes. Replaces
 * `ReportExportService.exportToCSV` client-side serialization so every
 * report — regardless of module (Finance, HR, Attendance, Payroll,
 * Projects) — produces byte-identical CSV output driven by the same
 * column registry and format profile the PDF renderer uses.
 *
 * Shape mirrors the client's `ExportConfig`:
 *   { title, subtitle?, dateRange?, columns, rows, companyName?, currency?, generatedAt? }
 *
 * RFC 4180 compliant: UTF-8 BOM, CRLF row separators, `"` → `""`
 * escaping, wraps a cell whenever it contains `,` `"` `\r` `\n`.
 *
 * Pure `(config) → Uint8Array`. NO DB access. NO branding fetch —
 * `render-report` is expected to have already merged branding into
 * `config.companyName` via the standard organization branding path.
 */

export type ReportColumnFormat = "text" | "currency" | "number" | "date" | "percent";

export interface ReportExportColumn {
  key: string;
  header: string;
  width?: number;
  format?: ReportColumnFormat;
  align?: "left" | "center" | "right";
}

export interface ReportExportRow {
  [key: string]: string | number | boolean | null | undefined;
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
  _depth?: number;
}

export interface ReportExportConfig {
  title: string;
  subtitle?: string;
  dateRange?: string;
  companyName?: string;
  currency?: string;
  columns: ReportExportColumn[];
  rows: ReportExportRow[];
  /** ISO 8601 timestamp for the "Generated:" footer. */
  generatedAt?: string;
}

const CRLF = "\r\n";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "number" ? String(value) : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

function formatCell(value: unknown, col: ReportExportColumn): unknown {
  if (value === null || value === undefined) return "";
  if (col.format === "currency" && typeof value === "number") {
    return value.toFixed(2);
  }
  if (typeof value === "boolean") return String(value);
  return value;
}

export function buildReportCsv(config: ReportExportConfig): Uint8Array {
  const lines: string[] = [];

  // Masthead (single-column cells; opens cleanly in Excel/Numbers).
  lines.push(csvRow([config.title]));
  if (config.companyName) lines.push(csvRow([config.companyName]));
  if (config.subtitle) lines.push(csvRow([config.subtitle]));
  if (config.dateRange) lines.push(csvRow([config.dateRange]));
  lines.push("");

  // Column headers.
  lines.push(csvRow(config.columns.map((c) => c.header)));

  // Body rows.
  for (const row of config.rows) {
    lines.push(
      csvRow(config.columns.map((col) => formatCell(row[col.key], col))),
    );
  }

  // Footer.
  lines.push("");
  const generated = config.generatedAt ?? new Date().toISOString();
  lines.push(csvRow([`Generated: ${generated}`]));

  const body = "\uFEFF" + lines.join(CRLF) + CRLF;
  return new TextEncoder().encode(body);
}
