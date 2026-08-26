/**
 * reportFormat — the single on-screen formatting policy for financial
 * reports.
 *
 * This mirrors, character for character, the server-side policy in
 * `supabase/functions/_shared/format/currency.ts` +
 * `_shared/pdf/components/DataTable.ts#formatCellValue`, which every PDF /
 * CSV / XLSX export already funnels through. Before this module, each
 * report page defined a local `fmt` / `fmtOrDash`, so the same figure could
 * read `-KES 1,234` on screen and `(KES 1,234.00)` in its own PDF.
 *
 * Rules (identical to the PDF engine):
 *   - currency: `KSh 1,234.56`, negatives in parentheses `(KSh 1,234.56)`
 *   - fraction digits come from the currency catalogue (ISO minor units),
 *     never a hardcoded 2 — JPY/RWF print whole units
 *   - number:   en-US grouping, no forced decimals
 *   - percent:  one fraction digit + `%`
 *   - empty / null / undefined / "" → em dash `—`
 *
 * A parity test (`src/test/architecture/report-format-parity.test.ts`)
 * asserts this file and the edge formatter agree on a shared fixture set.
 */

import {
  formatCurrencyDigits,
  getCurrencyDecimals,
  getCurrencyPrefix,
} from "@/lib/currency/catalogue";

export const EMPTY_CELL = "—";

/** Symbol as printed, including its separating space (`KSh `, `$`). */
export function getCurrencySymbol(code?: string | null): string {
  return getCurrencyPrefix(code);
}

/** Minor units for a currency, catalogue-driven (JPY 0, KWD 3, default 2). */
export { getCurrencyDecimals };

/** `KSh 1,234.56` / `(KSh 1,234.56)` — the accounting convention. */
export function formatAccountingNumber(value: number, currencyCode?: string | null): string {
  const symbol = getCurrencySymbol(currencyCode);
  const formatted = formatCurrencyDigits(value, currencyCode);
  return value < 0 ? `(${symbol}${formatted})` : `${symbol}${formatted}`;
}

/** Amount with no symbol; negatives still parenthesised. */
export function formatAccountingAmount(value: number, currencyCode?: string | null): string {
  const formatted = formatCurrencyDigits(value, currencyCode);
  return value < 0 ? `(${formatted})` : formatted;
}

export function formatReportNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatReportPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatReportDate(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export type ReportValueFormat =
  | "text"
  | "currency"
  | "amount"
  | "number"
  | "percent"
  | "date";

/**
 * The one cell formatter. Mirrors the PDF `formatCellValue` including its
 * blank-cell handling, so a report reads the same on screen and on paper.
 */
export function formatReportValue(
  value: unknown,
  format: ReportValueFormat = "text",
  currency?: string | null,
): string {
  if (value === null || value === undefined || value === "") return EMPTY_CELL;

  if (typeof value === "number") {
    if (Number.isNaN(value)) return EMPTY_CELL;
    switch (format) {
      case "currency":
        return formatAccountingNumber(value, currency);
      case "amount":
        return formatAccountingAmount(value, currency);
      case "number":
        return formatReportNumber(value);
      case "percent":
        return formatReportPercent(value);
      default:
        return formatReportNumber(value);
    }
  }

  if (format === "date") return formatReportDate(value as string);
  return String(value);
}

/** Zero suppression: accountants prefer a dash to a row of `0.00`. */
export function blankIfZero(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Math.abs(value) < 0.005 ? null : value;
}
