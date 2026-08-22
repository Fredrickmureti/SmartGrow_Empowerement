/**
 * Report Export Service
 *
 * Enterprise-grade export functionality. Milestone C.2:
 *   - CSV and XLSX are generated server-side by the `render-report` edge
 *     function using the same `_shared/exports/*` builders that back
 *     scheduled + emailed exports. The client no longer imports the
 *     `xlsx` library; frontend serialization would drift from PDF over
 *     time (masthead, currency formatting, branding). See ADR-0084.
 *   - PDF: unchanged — routed through `render-report`.
 *   - Print-in-page: unchanged — reuses the PDF path.
 *
 * The `no-raw-xlsx-in-app` ESLint rule pins this — anything under
 * `src/` (outside this file's `render-report` invocation) importing
 * `xlsx` is a bug.
 */

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
  /**
   * Header band this column sits under ("Opening balance"). Contiguous
   * columns sharing a label print under one centred caption in the PDF and
   * as a merged band in XLSX/CSV, so a trial balance's Debit/Credit pairs
   * are never anonymous. Omitted = single-tier header.
   */
  group?: string;
}


export interface ExportRow {
  // deno-lint-ignore-next-line
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  /**
   * Canonical semantic kind of the line — see
   * `src/design-system/reports/statementKinds.ts`. This is what the PDF
   * renderer reads; the three booleans below are the legacy fallback.
   */
  _kind?: string;
  _isHeader?: boolean;
  _isSubtotal?: boolean;
  _isGrandTotal?: boolean;
  _depth?: number;
  /** Serialisable drill-down provenance. Never rendered. */
  _meta?: {
    accountId?: string;
    accountIds?: string[];
    journalId?: string;
    sourceDocType?: string;
    sourceDocId?: string;
  };
}


export interface ExportConfig {
  title: string;
  subtitle?: string;
  /** Range reports: "1 Jan 2026 to 31 Mar 2026". */
  dateRange?: string;
  /**
   * Point-in-time reports (Trial Balance, Balance Sheet). Renders
   * "As of <asOf>" in the masthead instead of "For the period …".
   * Mutually exclusive with `dateRange`.
   */
  asOf?: string;
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
   *
   * NOTE (C.2): kept in the type for backwards compatibility, but
   * `render-report` now resolves the company name server-side from
   * `getOrganizationBranding(organizationId)` for tabular exports so
   * the CSV / XLSX masthead matches the PDF masthead exactly.
   */
  companyName?: string;
  /**
   * INTERNAL ONLY — populated by `ReportContext.enrichExportConfig`.
   * The reporting ENTITY. `render-report` resolves the masthead legal
   * name, logo and base currency for THIS business (not the org's first
   * business), so a multi-entity tenant cannot print one entity's logo on
   * another entity's statement.
   */
  businessId?: string;
  /**
   * INTERNAL ONLY — populated by `ReportContext.enrichExportConfig`.
   * The branch the report was scoped to (null = consolidated). The server
   * derives the masthead scope line from it; pages MUST NOT compose a
   * "Business · Branch" string themselves.
   */
  branchId?: string | null;
  /**
   * Registry key (e.g. "trial_balance"). Drives the canonical column
   * spec, orientation, masthead format profile and typography from
   * `_shared/reports/columnSpecs.ts`.
   *
   * REQUIRED for every registered report. Omitting it silently downgrades
   * the report to the "operational" masthead — that is exactly how Trial
   * Balance and Cash Flow drifted apart.
   */
  reportType?: string;
  /**
   * Masthead style for reports that legitimately have NO registry entry
   * (bespoke reconciliations, FX revaluation, valuation schedules).
   * Registered reports must NOT set this — their profile comes from
   * `columnSpecs.ts`, which stays the single source of truth.
   */
  formatProfile?: "financial" | "operational";
}

/**
 * Server-build hints. When a page supplies `reportType` + period +
 * `organizationId`, every export (PDF, CSV, XLSX) is regenerated by the
 * edge function from the canonical builder instead of re-shipping the
 * browser's rows. This is what keeps an export identical to the screen
 * while still containing the FULL dataset rather than the page's slice.
 */
export interface ServerBuildConfig extends ExportConfig {
  dateFrom?: string;
  dateTo?: string;
  filters?: Record<string, unknown>;
}


/**
 * True when the config carries everything `render-report`'s SERVER-BUILD
 * mode needs. Prebuilt (client rows) stays the fallback for pages that
 * compose bespoke datasets with no registry key.
 */
function canServerBuild(config: ExportConfig): config is ServerBuildConfig & {
  reportType: string;
  organizationId: string;
  dateFrom: string;
  dateTo: string;
} {
  const c = config as ServerBuildConfig;
  return Boolean(c.reportType && c.organizationId && c.dateFrom && c.dateTo);
}

/**
 * Builds the wire payload. Server-build requests deliberately OMIT
 * `rows`/`columns` — sending them would trip the prebuilt branch in
 * `render-report` and reintroduce the client-rows drift.
 */
function buildRenderPayload(
  config: ExportConfig,
  wireFormat: "pdf" | "csv" | "xlsx",
): Record<string, unknown> {
  const base = {
    title: config.title,
    subtitle: config.subtitle,
    dateRange: config.dateRange,
    asOf: config.asOf,
    organizationId: config.organizationId,
    // Identity: the reporting entity + scope the masthead must state.
    businessId: config.businessId,
    branchId: config.branchId ?? null,
    reportType: config.reportType,
    formatProfile: config.formatProfile,
    currency: config.currency,
  };

  if (canServerBuild(config)) {
    return {
      ...base,
      dateFrom: config.dateFrom,
      dateTo: config.dateTo,
      businessId: config.businessId,
      filters: config.filters,
      format: wireFormat,
    };
  }
  return {
    ...base,
    columns: config.columns,
    rows: config.rows,
    ...(wireFormat === "pdf"
      ? { orientation: "landscape" as const }
      : { format: wireFormat }),
  };
}

// ─── CSV / XLSX Export (server-side via render-report) ───────────────

export async function exportToCSV(config: ExportConfig): Promise<void> {
  const blob = await fetchReportTabularBlob(config, "csv");
  downloadBlob(blob, `${sanitizeFilename(config.title)}_${format(new Date(), "yyyy-MM-dd")}.csv`);
}

export async function exportToExcel(config: ExportConfig): Promise<void> {
  const blob = await fetchReportTabularBlob(config, "xlsx");
  downloadBlob(blob, `${sanitizeFilename(config.title)}_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
}

/**
 * XLSX/CSV bytes are fetched with a raw `fetch`, NOT `functions.invoke`.
 *
 * `supabase.functions.invoke` decodes the response by Content-Type and
 * only treats `application/json`, `application/octet-stream` and
 * `application/pdf` as structured/binary — everything else falls through
 * to `response.text()`. An XLSX served as
 * `…spreadsheetml.sheet` was therefore decoded as UTF-8 text, which
 * mangles every non-UTF-8 byte in the zip container: Excel then reports
 * the workbook as corrupt. Reading the response as a Blob keeps the bytes
 * intact. (PDF is unaffected — invoke blobs that one.)
 */
async function fetchReportTabularBlob(
  config: ExportConfig,
  wireFormat: "csv" | "xlsx",
): Promise<Blob> {
  const { supabase } = await import("@/integrations/supabase/client");
  const mime =
    wireFormat === "csv"
      ? "text/csv;charset=utf-8;"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const payload = buildRenderPayload(config, wireFormat);

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
  const functionsUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/render-report`;

  const response = await fetch(functionsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${accessToken ?? anonKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `render-report failed (${response.status}): ${detail.slice(0, 500)}`,
    );
  }

  const blob = await response.blob();
  return blob.type ? blob : new Blob([blob], { type: mime });
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
// Preview now uses the actual server-generated PDF (see ReportPreviewDialog).

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
  // Currency stays an allowed explicit override (multi-currency reports);
  // org base_currency is the fallback when omitted.
  const payload = buildRenderPayload(config, "pdf");

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
