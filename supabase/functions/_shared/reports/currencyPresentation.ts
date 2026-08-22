/**
 * Multi-currency presentation for ledger documents — ONE rule, shared by the
 * on-screen register (`src/pages/reports/*`) and the archived PDF/CSV/XLSX
 * (`_shared/reportDataEngine.ts`).
 *
 * THE ACCOUNTING RULE
 *   `journal_entry_lines.debit / credit` are BASE currency and are the only
 *   authority. Every total, running balance, subtotal and tie-out on every
 *   ledger document is base currency, always. Foreign-currency information is
 *   a SUPPLEMENT: it says what the source document said, it never participates
 *   in arithmetic.
 *
 *   - Trial Balance: base currency only. A trial balance in mixed units does
 *     not balance, so it gains no FX columns — ever.
 *   - General Ledger / Posting Journal: when (and only when) the run actually
 *     contains a foreign-currency line, three supplementary columns appear —
 *     Currency, Document amount, Rate — and the masthead states the base
 *     currency the money columns are expressed in.
 *
 * The columns are conditional on purpose: printing three empty columns on the
 * ledger of a single-currency company wastes a third of a landscape page.
 */

import type { ReportColumn } from "../reportPdfGenerator.ts";

/** Row keys the ledger documents use for the FX supplement. */
export const FX_KEYS = {
  currency: "currency",
  documentAmount: "doc_amount",
  rate: "fx_rate",
} as const;

export interface FxLineInput {
  entryCurrency?: string | null;
  originalDebit?: number | string | null;
  originalCredit?: number | string | null;
  exchangeRate?: number | string | null;
}

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A line is foreign when its entry currency differs from the reporting base
 * currency. With no base currency known we cannot claim a line is foreign, so
 * we say no rather than mislabel a domestic ledger.
 */
export function isForeignLine(
  entryCurrency: string | null | undefined,
  baseCurrency: string | null | undefined,
): boolean {
  if (!entryCurrency || !baseCurrency) return false;
  return entryCurrency.toUpperCase() !== baseCurrency.toUpperCase();
}

/** True when the run has at least one foreign-currency line worth printing. */
export function hasForeignCurrency(
  lines: FxLineInput[],
  baseCurrency: string | null | undefined,
): boolean {
  return lines.some(
    (l) =>
      isForeignLine(l.entryCurrency, baseCurrency) &&
      (num(l.originalDebit) !== null || num(l.originalCredit) !== null),
  );
}

/**
 * "USD 1,200.00" — the amount as written on the source document. Empty for a
 * domestic line, so the column stays quiet on the lines that do not need it.
 */
export function formatDocumentAmount(
  line: FxLineInput,
  baseCurrency: string | null | undefined,
): string {
  if (!isForeignLine(line.entryCurrency, baseCurrency)) return "";
  const debit = num(line.originalDebit);
  const credit = num(line.originalCredit);
  const amount = debit && debit !== 0 ? debit : credit && credit !== 0 ? credit : null;
  if (amount === null) return "";
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount));
  return `${(line.entryCurrency as string).toUpperCase()} ${formatted}`;
}

/** The rate used to translate the document into base currency, or null. */
export function documentRate(
  line: FxLineInput,
  baseCurrency: string | null | undefined,
): number | null {
  if (!isForeignLine(line.entryCurrency, baseCurrency)) return null;
  const rate = num(line.exchangeRate);
  return rate && rate !== 1 ? rate : rate;
}

/** The FX supplement as document cells, ready to spread into a row. */
export function fxCells(
  line: FxLineInput,
  baseCurrency: string | null | undefined,
): Record<string, string | number | null> {
  const foreign = isForeignLine(line.entryCurrency, baseCurrency);
  return {
    [FX_KEYS.currency]: foreign ? (line.entryCurrency as string).toUpperCase() : "",
    [FX_KEYS.documentAmount]: formatDocumentAmount(line, baseCurrency),
    [FX_KEYS.rate]: documentRate(line, baseCurrency),
  };
}

/** PDF/CSV column specs for the supplement, in printing order. */
export const FX_PDF_COLUMNS: ReportColumn[] = [
  { key: FX_KEYS.currency, header: "Curr.", width: 7, align: "left", format: "text" },
  { key: FX_KEYS.documentAmount, header: "Document amt", width: 14, align: "right", format: "text" },
  { key: FX_KEYS.rate, header: "Rate", width: 9, align: "right", format: "number" },
];

/**
 * Insert the FX supplement immediately before the money columns, so the
 * reader goes "…what the document said → what the books say".
 */
export function withFxColumns(
  columns: ReportColumn[],
  firstMoneyKey = "debit",
): ReportColumn[] {
  const at = columns.findIndex((c) => c.key === firstMoneyKey);
  const index = at === -1 ? columns.length : at;
  return [...columns.slice(0, index), ...FX_PDF_COLUMNS, ...columns.slice(index)];
}

/** Masthead line that names the unit every money column is expressed in. */
export function baseCurrencyNote(baseCurrency: string | null | undefined): string {
  return baseCurrency ? `Amounts in ${baseCurrency.toUpperCase()} (base currency)` : "";
}
