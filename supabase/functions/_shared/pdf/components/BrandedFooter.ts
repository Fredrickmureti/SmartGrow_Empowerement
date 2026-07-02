/**
 * BrandedFooter — page number (right) and optional centered footer note.
 *
 * Currently the financial-report PDF stamps "Page N" on every page and
 * "Generated: ..." on the last page. This component owns both behaviors.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import { winansiSafe } from "../winansi.ts";

export interface FooterDisclosure {
  user?: string | null;
  org?: string | null;
  runHash?: string | null;
}

export interface FooterConfig {
  /** Optional centered note (e.g. "Confidential - Do not distribute"). */
  footerNote?: string;
  /** When true, also stamp "Generated: ..." on bottom-left. */
  includeGeneratedStamp?: boolean;
  /**
   * Stage 4: standard disclosure line. When provided, it REPLACES the
   * legacy left-aligned generated stamp with a single canonical line:
   *   "Generated {ts} by {user} • {org} • Run {hash}"
   * This is the accountant-grade audit fingerprint that ties a printed
   * report back to a `report_run_log` row.
   */
  disclosure?: FooterDisclosure;
}

/**
 * Draws "Page N" on a single page. Called per-page from the BrandedHeader
 * lifecycle (onNewPage in the report generator).
 */
export function drawPageNumber(builder: PdfBuilder, page: PDFPage): void {
  const { state, fontRegular } = builder;
  const pageText = `Page ${state.pageNum}`;
  const w = fontRegular.widthOfTextAtSize(pageText, theme.size.pageNumber);
  page.drawText(pageText, {
    x: state.pageWidth - state.margin - w,
    y: state.margin - 25,
    size: theme.size.pageNumber, font: fontRegular, color: theme.color.lightGray,
  });
}

/**
 * Draws the bottom-of-last-page footer (generated stamp + optional note).
 * Called once at the end of report generation.
 */
export function drawFinalFooter(builder: PdfBuilder, page: PDFPage, config: FooterConfig = {}): void {
  const { state, fontRegular } = builder;
  const ts = state.generatedStamp.replace(/^Report generated:\s*/, "");

  // Build the canonical disclosure line when caller supplied audit info.
  let leftText = "";
  if (config.disclosure) {
    const parts: string[] = [`Generated ${ts}`];
    if (config.disclosure.user) parts.push(`by ${config.disclosure.user}`);
    if (config.disclosure.org) parts.push(config.disclosure.org);
    if (config.disclosure.runHash) parts.push(`Run ${config.disclosure.runHash}`);
    leftText = winansiSafe(parts.join(" • "));
  } else if (config.includeGeneratedStamp !== false) {
    leftText = winansiSafe(`Generated: ${ts}`);
  }

  if (leftText) {
    page.drawText(leftText, {
      x: state.margin,
      y: state.margin - 25,
      size: theme.size.footerNote, font: fontRegular, color: theme.color.lightGray,
    });
  }

  if (config.footerNote) {
    const safeFooterNote = winansiSafe(config.footerNote);
    const w = fontRegular.widthOfTextAtSize(safeFooterNote, theme.size.footerNote);
    page.drawText(safeFooterNote, {
      x: state.pageWidth / 2 - w / 2,
      y: state.margin - 25,
      size: theme.size.footerNote, font: fontRegular, color: theme.color.lightGray,
    });
  }
}
