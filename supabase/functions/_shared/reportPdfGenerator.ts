/**
 * Shared Report PDF Generator
 *
 * Thin composition layer over the unified PDF primitives in `_shared/pdf/`.
 * This file used to contain ~550 lines of pdf-lib calls; it now delegates
 * to BrandedHeader / DataTable / SummaryBlock / BrandedFooter.
 *
 * The public API (ReportPdfPayload, OrganizationBranding, generateReportPdf)
 * is preserved for backward compatibility — callers (generate-report-pdf,
 * process-scheduled-reports) continue to work unchanged.
 */

import {
  PdfBuilder,
  drawBrandedHeader,
  embedLogo,
  drawDataTable,
  drawRecipientBlock,
  drawSummaryBlock,
  drawPageNumber,
  stampPageNumbers,
  drawFinalFooter,
  type TableColumn,
  type TableRow,
  type RecipientInfo,
  type PaperPreset,
  type PaperSpec,
  resolveTypography,
  type PresentationProfile,
} from "./pdf/index.ts";
import { fetchLogoBytes, type OrganizationBranding } from "./branding/index.ts";

// ── Re-exported types (preserve public API) ────────────────────────────

export type ReportColumn = TableColumn;
export type ReportRow = TableRow;
export type { OrganizationBranding, RecipientInfo };

export interface SummaryRow {
  label: string;
  value: string;
}

export interface ReportPdfPayload {
  title: string;
  subtitle?: string;
  companyName?: string;
  dateRange?: string;
  /** Point-in-time reports: renders "As of …" instead of "For the period …". */
  asOf?: string;
  /** Reporting scope line ("<Business> · <Branch>"), derived by renderReport. */
  scope?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  currency?: string;

  orientation?: "portrait" | "landscape";
  organization?: OrganizationBranding;
  recipientInfo?: RecipientInfo;
  summaryRows?: SummaryRow[];
  amountDue?: string;
  /** Optional centered footer note (replaces legacy hardcoded "Confidential"). */
  footerNote?: string;
  /**
   * Stage W5 (ADR-0008): paper format for the rendered report.
   * Reports never emit ESC/POS — only PDF paper sizes are accepted.
   * Defaults to A4 when omitted, matching pre-W5 behaviour.
   */
  paperFormat?: PaperPreset | PaperSpec;
  /**
   * Stage 3: drives header style.
   *   "financial" → centered statutory masthead (logo, legal name, title,
   *                 period/as-of, basis, scope, prepared on).
   *   "operational" (default) → existing logo-left / title-right layout.
   */
  formatProfile?: "financial" | "operational";

  /**
   * Presentation profile — drives typography and density only (never data,
   * never semantics). Resolved centrally by the report registry; callers
   * should normally leave it unset. Omitted = derived from `formatProfile`
   * and the column count, which is what `renderReport` does.
   */
  presentationProfile?: PresentationProfile;
  /**
   * Stage 4: standard disclosure line drawn on the last page footer.
   * Format: `Generated {timestamp} by {user} • {org} • Export ref {short-hash}`.
   * `runHash` identifies THIS rendition of the document — it is never a
   * business run (a consolidation run, a payroll run), so it must never be
   * labelled "Run" on the artifact.
   * If omitted, falls back to the legacy generated-stamp footer.
   */
  disclosure?: {
    user?: string | null;
    org?: string | null;
    runHash?: string | null;
  };

}

// ── Generator ──────────────────────────────────────────────────────────

export async function generateReportPdf(payload: ReportPdfPayload): Promise<Uint8Array> {
  const {
    title,
    subtitle,
    dateRange,
    asOf,
    scope,
    columns,
    rows,
    currency,
    orientation = "landscape",
    organization,
    companyName,
    recipientInfo,
    summaryRows,
    amountDue,
    footerNote,
    formatProfile = "operational",
    presentationProfile,
    disclosure,
    paperFormat,
  } = payload;

  // Presentation profile is OPT-IN at this layer. Direct callers — tax
  // certificates, statutory returns, payroll documents — are regulator- or
  // layout-pinned and must keep byte-identical output, so the default is
  // the document profile (i.e. the pre-profile behaviour). The analytical
  // report funnel (`_shared/reports/renderReport.ts`) passes an explicit
  // profile resolved from the report registry.
  const typography = resolveTypography(presentationProfile ?? "document");

  // Statement mode: the statutory presentation policy (semantic spacing
  // around totals, nil as an accounting dash, "(continued)" mastheads,
  // "Page i of N"). Gated on the statement profile so every other document
  // — invoices, ledgers, registers, certificates — is byte-identical.
  const isStatement = presentationProfile === "statement";

  const builder = await PdfBuilder.create({
    orientation,
    paperFormat,
    margin: typography.pageMargin,
    bottomMargin: typography.bottomMargin,
  });

  // Embed the logo once; reused on every page header. The legal entity's
  // logo is part of document identity, so BOTH mastheads carry it — the
  // financial masthead centers it above the legal name. Missing or
  // un-embeddable logos degrade to a text-only masthead.
  const logoBytes = organization?.logo_url
    ? await fetchLogoBytes(organization.logo_url)
    : null;
  const logo = await embedLogo(builder, logoBytes);

  let lastSeparatorY = 0;

  builder.onNewPage = (page) => {
    // Statements get "Page i of N" stamped after the fact, once the total
    // is known (see stampPageNumbers below).
    if (!isStatement) drawPageNumber(builder, page, typography);
    const continued = isStatement && builder.state.pageNum > 1;
    const drawn = drawBrandedHeader(builder, page, {
      title: continued ? `${title} (continued)` : title,
      subtitle,
      // Operational header has a single date slot; feed it whichever the
      // report supplied. The financial masthead distinguishes the two.
      dateRange: dateRange ?? asOf,
      asOf,
      scope,
      organization: organization ?? null,
      companyName,
      logo,
      formatProfile,
      typography,
    });
    lastSeparatorY = drawn.separatorY;
    return drawn.bodyY;
  };


  builder.newPage();

  if (recipientInfo) {
    drawRecipientBlock(builder, builder.page, {
      recipient: recipientInfo,
      amountDue,
      separatorY: lastSeparatorY,
    });
  }

  drawDataTable(builder, { columns, rows, currency, typography, statement: isStatement });

  if (summaryRows && summaryRows.length > 0) {
    drawSummaryBlock(builder, builder.page, summaryRows);
  }

  if (isStatement) stampPageNumbers(builder, typography);

  // Final footer: standard disclosure on the last page.
  drawFinalFooter(builder, builder.page, {
    footerNote,
    includeGeneratedStamp: true,
    disclosure,
    typography,
  });

  return await builder.save();
}
