/**
 * Multi-currency presentation for ledger screens.
 *
 * Client mirror of `supabase/functions/_shared/reports/currencyPresentation.ts`
 * — the screen and the archived PDF must state the same thing, so the rule
 * lives in one shape in two runtimes (the edge module cannot be imported by
 * Vite, and the client module cannot be imported by Deno).
 *
 * THE ACCOUNTING RULE
 *   `debit` / `credit` are base currency and are the sole authority for every
 *   total, running balance and tie-out. Foreign-currency values are a
 *   SUPPLEMENT that records what the source document said; they never enter
 *   arithmetic. Trial Balance never shows them — a trial balance in mixed
 *   units does not balance. General Ledger and Posting Journal show them only
 *   when the run actually contains a foreign line.
 */

import { formatCurrencyDigits } from "@/lib/currency/catalogue";

export interface FxLine {
  entryCurrency?: string | null;
  originalDebit?: number | null;
  originalCredit?: number | null;
  exchangeRate?: number | null;
}

export function isForeignLine(
  entryCurrency: string | null | undefined,
  baseCurrency: string | null | undefined,
): boolean {
  if (!entryCurrency || !baseCurrency) return false;
  return entryCurrency.toUpperCase() !== baseCurrency.toUpperCase();
}

/** True when at least one line is worth printing the supplement for. */
export function hasForeignCurrency(
  lines: FxLine[],
  baseCurrency: string | null | undefined,
): boolean {
  return lines.some(
    (l) =>
      isForeignLine(l.entryCurrency, baseCurrency) &&
      (l.originalDebit != null || l.originalCredit != null),
  );
}

/** "USD 1,200.00" as written on the source document; empty when domestic. */
export function formatDocumentAmount(
  line: FxLine,
  baseCurrency: string | null | undefined,
): string {
  if (!isForeignLine(line.entryCurrency, baseCurrency)) return "";
  const amount =
    line.originalDebit && line.originalDebit !== 0
      ? line.originalDebit
      : line.originalCredit && line.originalCredit !== 0
        ? line.originalCredit
        : null;
  if (amount == null) return "";
  const code = line.entryCurrency!.toUpperCase();
  // Minor units come from the currency catalogue: a JPY supplement must not
  // grow phantom cents just because the base currency has two decimals.
  return `${code} ${formatCurrencyDigits(amount, code)}`;
}

/** Translation rate applied to the document, or null for a domestic line. */
export function documentRate(
  line: FxLine,
  baseCurrency: string | null | undefined,
): number | null {
  if (!isForeignLine(line.entryCurrency, baseCurrency)) return null;
  return line.exchangeRate ?? null;
}

/** Rate as printed: enough precision to reproduce the base amount. */
export function formatRate(rate: number | null): string {
  if (rate == null) return "";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(rate);
}

/** Masthead line naming the unit the money columns are expressed in. */
export function baseCurrencyNote(baseCurrency: string | null | undefined): string {
  return baseCurrency ? `Amounts in ${baseCurrency.toUpperCase()} (base currency)` : "";
}
