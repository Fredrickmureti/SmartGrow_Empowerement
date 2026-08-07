/**
 * presentation.ts — report presentation profiles (typography + density).
 *
 * WHY THIS EXISTS
 * ---------------
 * `accountantMono.ts` was, and remains, the single source of colour and
 * layout truth for every PDF the platform emits. The problem it created is
 * that transactional documents (invoice, estimate, PO, credit note) and
 * analytical reports (trial balance, general ledger, P&L, payroll register)
 * shared ONE body size — 7.5pt — with a numeric shrink floor of 6pt.
 *
 * A 3-column invoice at 7.5pt on portrait A4 reads fine. A 9-column general
 * ledger at 7.5pt on landscape A4 (842pt wide, which every viewer then
 * fits-to-window at ~0.8x) does not: the effective on-screen size lands
 * around 6px, which is why analytical reports needed 150–180% zoom.
 *
 * This module does NOT introduce a second theme or a second renderer. It
 * resolves the existing theme's size/spacing tokens against a presentation
 * profile, and the profile is chosen centrally by the report registry —
 * never by a calling page.
 *
 *   document    → unchanged, byte-for-byte. Invoices, estimates, quotes,
 *                 purchase orders, sales orders, credit notes, receipts.
 *   statement   → few columns, statutory. Balance Sheet, P&L, Cash Flow.
 *   ledger      → intrinsically dense. Trial Balance, GL, partner ledgers,
 *                 journals, aging, payroll register. Buys width back from
 *                 the margins instead of shrinking digits.
 *   operational → registers. Inventory, sales, purchases, POS, projects, CRM.
 */

import { theme, type Theme } from "./accountantMono.ts";

export type PresentationProfile =
  | "document"
  | "statement"
  | "ledger"
  | "operational";

/** Theme size tokens widened from literal types to plain numbers. */
export type TypographySizes = { [K in keyof Theme["size"]]: number };

export interface Typography {
  size: TypographySizes;
  rowHeight: number;
  tableHeaderHeight: number;
  blockGap: number;
  pageMargin: number;
  bottomMargin: number;
  /**
   * Numeric cells shrink rather than truncate (truncating a monetary figure
   * would misstate it). This is the floor that shrink may not cross.
   */
  minNumericFontSize: number;
}

function build(
  sizeOverrides: Partial<TypographySizes>,
  layout: Partial<Omit<Typography, "size">>,
): Typography {
  return {
    size: { ...theme.size, ...sizeOverrides },
    rowHeight: layout.rowHeight ?? theme.rowHeight,
    tableHeaderHeight: layout.tableHeaderHeight ?? theme.tableHeaderHeight,
    blockGap: layout.blockGap ?? theme.blockGap,
    pageMargin: layout.pageMargin ?? theme.pageMargin,
    bottomMargin: layout.bottomMargin ?? theme.bottomMargin,
    minNumericFontSize: layout.minNumericFontSize ?? 6,
  };
}

/**
 * The document profile is the pre-existing behaviour, expressed as data.
 * It must stay identical to `theme` — an architecture test asserts this,
 * because any drift here silently reformats every invoice in the system.
 */
const DOCUMENT: Typography = build({}, {});

/**
 * Financial statements carry few columns and are read line by line, often
 * printed and filed. They can afford ~10pt body and taller rows — this is
 * the density SAP/Oracle/NetSuite statutory statements use.
 */
const STATEMENT: Typography = build(
  {
    tableHeader: 10,
    tableCell: 10,
    tableCellEmphasis: 10.5,
    orgDetail: 9,
    timestamp: 9,
    pageNumber: 9,
    footerNote: 9,
    summaryLabel: 9,
    summaryValue: 10,
  },
  {
    rowHeight: 18,
    minNumericFontSize: 8.5,
  },
);

/**
 * Ledgers are legitimately dense — a GL line has date, reference,
 * description, account, debit, credit and running balance, and an
 * accountant expects many rows per page. The fix for a ledger is therefore
 * mostly horizontal: reclaim 64pt of gutter (72 → 40 per side) and spend it
 * on column width, then raise the shrink floor so digits stop collapsing.
 */
const LEDGER: Typography = build(
  {
    tableHeader: 9,
    tableCell: 8.5,
    tableCellEmphasis: 9,
    orgDetail: 8.5,
    timestamp: 8.5,
    pageNumber: 8.5,
    footerNote: 8.5,
    summaryLabel: 8.5,
    summaryValue: 9,
  },
  {
    rowHeight: 16,
    pageMargin: 40,
    bottomMargin: 44,
    minNumericFontSize: 7.5,
  },
);

/** Operational registers sit between the two — moderate column counts. */
const OPERATIONAL: Typography = build(
  {
    tableHeader: 9.5,
    tableCell: 9,
    tableCellEmphasis: 9.5,
    orgDetail: 8.5,
    timestamp: 8.5,
    pageNumber: 8.5,
    footerNote: 8.5,
    summaryLabel: 8.5,
    summaryValue: 9,
  },
  {
    rowHeight: 17,
    pageMargin: 48,
    bottomMargin: 48,
    minNumericFontSize: 8,
  },
);

const PROFILES: Record<PresentationProfile, Typography> = {
  document: DOCUMENT,
  statement: STATEMENT,
  ledger: LEDGER,
  operational: OPERATIONAL,
};

/** Resolve a profile to its token set. Unknown input falls back to document. */
export function resolveTypography(
  profile: PresentationProfile | undefined | null,
): Typography {
  return PROFILES[(profile ?? "document") as PresentationProfile] ?? DOCUMENT;
}

/**
 * Column-count heuristic used when a report registry entry has not pinned a
 * profile explicitly. Statutory statements are decided by `formatProfile`;
 * everything else is graded by how much horizontal pressure it carries.
 */
export function inferPresentationProfile(
  formatProfile: "financial" | "operational" | undefined,
  columnCount: number,
): PresentationProfile {
  // A statutory statement is narrow by nature (account + one or two value
  // columns) and earns the 10pt statement face. A wide "financial" report
  // — trial balance, budget vs actual — is a schedule, not a statement:
  // measured at 10pt it grows from 2 pages to 3 without becoming easier to
  // read, so it grades down to the ledger face instead.
  if (formatProfile === "financial") return columnCount >= 6 ? "ledger" : "statement";
  return columnCount >= 7 ? "ledger" : "operational";
}

export const DOCUMENT_TYPOGRAPHY = DOCUMENT;
