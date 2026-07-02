/**
 * accountantMono — the canonical theme for ALL reports and documents.
 *
 * Stage 3 (now active): minimal-only palette.
 *   • Black text on white. Mid-grey rules and subdued labels.
 *   • NO row tints (subtotal/grand-total/header/section bands removed).
 *     Emphasis is achieved by bold weight + accounting underlines, not fills.
 *   • NO blue accent colour. Section labels and "Amount Due" use plain text
 *     colour; visual prominence comes from typography.
 *
 * The previous palette retained legacy tints for backward compatibility
 * during Stage 2 of the consolidation. Stage 3 commits to the accountant-
 * grade look approved by the user.
 */

import { rgb } from "https://esm.sh/pdf-lib@1.17.1";

export const theme = {
  // Page — 1" (72pt) breathing margins so content never touches the
  // paper edges. Matches standard professional letter / report formatting.
  pageMargin: 72,
  bottomMargin: 60,

  // Fonts (sizes)
  size: {
    title: 18,
    titleSmall: 14,         // when title.length > 25
    sectionLabel: 9,
    orgName: 14,
    orgDetail: 8,
    dateRange: 10,
    timestamp: 8,
    tableHeader: 8,
    tableCell: 7.5,
    tableCellEmphasis: 8.5, // header/subtotal/grand total rows
    summaryLabel: 7,
    summaryValue: 8,
    pageNumber: 8,
    footerNote: 8,
    recipientName: 11,
    recipientLine: 8,
    amountDueLabel: 9,
    amountDueValue: 14,
  },

  // Layout
  rowHeight: 14,
  tableHeaderHeight: 22, // bumped from 18 — gives column headers visible breathing room
  /**
   * Standard vertical gap between major sections (recipient → table,
   * table → totals, totals → notes). Use this constant instead of
   * hand-tuned -6 / -12 offsets so cumulative spacing stays consistent.
   */
  blockGap: 14,
  logoMaxW: 100,
  logoMaxH: 45,

  // Colors (rgb 0..1) — minimal accountant palette.
  // Stage I: removed legacy *Bg / accent aliases. Emphasis is achieved by
  // bold weight + accounting underlines, never by row tints. There is no
  // brand colour in reports — accountants don't print invoices in blue.
  color: {
    text: rgb(0.1, 0.1, 0.18),
    medGray: rgb(0.4, 0.4, 0.4),
    lightGray: rgb(0.6, 0.6, 0.6),
    border: rgb(0.85, 0.85, 0.85),
    headerBorder: rgb(0.55, 0.55, 0.55), // darker rule under column headers
  },
} as const;

export type Theme = typeof theme;
