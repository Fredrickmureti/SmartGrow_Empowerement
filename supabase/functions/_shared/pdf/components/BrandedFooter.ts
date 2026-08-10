/**
 * BrandedFooter — page number (right) and optional centered footer note.
 *
 * Currently the financial-report PDF stamps "Page N" on every page and
 * "Generated: ..." on the last page. This component owns both behaviors.
 */

import { PDFPage } from "https://esm.sh/pdf-lib@1.17.1";
import { PdfBuilder } from "../PdfBuilder.ts";
import { theme } from "../themes/accountantMono.ts";
import {
  DOCUMENT_TYPOGRAPHY,
  type Typography,
} from "../themes/presentation.ts";
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
  /** Resolved presentation tokens. Omitted = document profile. */
  typography?: Typography;
}

/**
 * Draws "Page N" on a single page. Called per-page from the BrandedHeader
 * lifecycle (onNewPage in the report generator).
 */
export function drawPageNumber(
  builder: PdfBuilder,
  page: PDFPage,
  typography?: Typography,
): void {
  const { state, fontRegular } = builder;
  const t = typography ?? DOCUMENT_TYPOGRAPHY;
  const pageText = `Page ${state.pageNum}`;
  const w = fontRegular.widthOfTextAtSize(pageText, t.size.pageNumber);
  page.drawText(pageText, {
    x: state.pageWidth - state.margin - w,
    y: Math.max(state.margin - 25, 14),
    size: t.size.pageNumber, font: fontRegular, color: theme.color.lightGray,
  });
}

/**
 * Stamps "Page i of N" on EVERY page once the document is complete.
 *
 * `drawPageNumber` runs while a page is being created, so it can only know
 * the current index — never the total. Statutory statements are filed and
 * bound, so an accountant must be able to tell a page is missing; that
 * requires the total, which is only knowable at the end.
 */
export function stampPageNumbers(
  builder: PdfBuilder,
  typography?: Typography,
): void {
  const { state, fontRegular } = builder;
  const t = typography ?? DOCUMENT_TYPOGRAPHY;
  const pages = builder.doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const text = winansiSafe(`Page ${i + 1} of ${total}`);
    const w = fontRegular.widthOfTextAtSize(text, t.size.pageNumber);
    page.drawText(text, {
      x: state.pageWidth - state.margin - w,
      y: Math.max(state.margin - 25, 14),
      size: t.size.pageNumber, font: fontRegular, color: theme.color.lightGray,
    });
  });
}

/**
 * Draws the bottom-of-last-page footer (generated stamp + optional note).
 * Called once at the end of report generation.
 */
export function drawFinalFooter(builder: PdfBuilder, page: PDFPage, config: FooterConfig = {}): void {
  const { state, fontRegular } = builder;
  const t = config.typography ?? DOCUMENT_TYPOGRAPHY;
  const footerY = Math.max(state.margin - 25, 14);
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

  let leftWidth = 0;
  if (leftText) {
    leftWidth = fontRegular.widthOfTextAtSize(leftText, t.size.footerNote);
    page.drawText(leftText, {
      x: state.margin,
      y: footerY,
      size: t.size.footerNote, font: fontRegular, color: theme.color.lightGray,
    });
  }

  if (config.footerNote) {
    const safeFooterNote = winansiSafe(config.footerNote);
    const w = fontRegular.widthOfTextAtSize(safeFooterNote, t.size.footerNote);
    // The centred note shares the baseline with the generated stamp on the
    // left and the page number on the right. Centring it blindly made a long
    // note collide with the stamp ("…UTComputer-generated statement…"), so
    // the note is pushed right of the stamp when true centring would overlap.
    const gap = 8;
    const minX = state.margin + (leftWidth > 0 ? leftWidth + gap : 0);
    const maxX = state.pageWidth - state.margin - w;
    const centredX = state.pageWidth / 2 - w / 2;
    const x = Math.min(Math.max(centredX, minX), Math.max(maxX, minX));
    if (x + w <= state.pageWidth - state.margin) {
      page.drawText(safeFooterNote, {
        x,
        y: footerY,
        size: t.size.footerNote, font: fontRegular, color: theme.color.lightGray,
      });
    }
  }
}
