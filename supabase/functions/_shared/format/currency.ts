/**
 * Currency formatting — single source of truth for the entire reporting engine.
 *
 * Used by:
 *   - Financial report PDFs (_shared/reportPdfGenerator.ts)
 *   - Sales document PDFs (_shared/pdfGenerator.ts via templateRenderer.ts)
 *   - Payroll PDFs
 *
 * Rules:
 *   - Currency symbol prefixes the value; alphabetic symbols keep a space.
 *   - Negatives render in parentheses (accounting convention).
 *   - Fraction digits come from the currency catalogue (`public.currencies`,
 *     falling back to ISO 4217 minor units) — NOT a hardcoded 2. A JPY or RWF
 *     figure prints as a whole-unit amount.
 *
 * Symbols and minor units live in `./catalogue.ts`, which mirrors the client
 * catalogue in `src/lib/currency/catalogue.ts`.
 */

import {
  formatCurrencyDigits,
  getCurrencyDecimals,
  getCurrencyPrefix,
  getCurrencySymbolRaw,
} from "./catalogue.ts";

export {
  getCurrencyDecimals,
  loadCurrencyCatalogue,
  setCurrencyCatalogue,
} from "./catalogue.ts";

/** Symbol as printed, including its separating space where applicable. */
export function getCurrencySymbol(code?: string): string {
  return getCurrencyPrefix(code);
}

/** Bare symbol with no spacing — for headers and column captions. */
export function getCurrencyGlyph(code?: string): string {
  return getCurrencySymbolRaw(code);
}

/**
 * Money is never allowed to print as `NaN`, `Infinity`, `null` or `undefined`.
 * A document is a legal artifact: a garbage numeric input must degrade to a
 * defensible `0.00`, never to a token that leaks an arithmetic bug onto paper.
 * Guarded centrally so every renderer (A4, thermal, ESC/POS, reports) inherits
 * the same floor.
 */
function coerceFinite(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Accountant-grade number formatting.
 * Negative: (KSh 1,234.56)
 * Positive: KSh 1,234.56
 */
export function formatAccountingNumber(value: number, currencyCode?: string): string {
  const symbol = getCurrencyPrefix(currencyCode);
  const safe = coerceFinite(value);
  const formatted = formatCurrencyDigits(safe, currencyCode);
  if (safe < 0) {
    return `(${symbol}${formatted})`;
  }
  return `${symbol}${formatted}`;
}

/**
 * Plain amount (no currency symbol). Negatives keep a minus sign.
 * Used for line totals inside sales documents that already show currency in
 * headers. The currency code is optional but should be passed when known, so
 * zero-decimal currencies do not gain phantom cents.
 */
export function formatAmount(value: number, currencyCode?: string): string {
  const safe = coerceFinite(value);
  const digits = formatCurrencyDigits(safe, currencyCode);
  return safe < 0 ? `-${digits}` : digits;
}

/** Minor units, re-exported for renderers that need to align columns. */
export function currencyDecimals(code?: string): number {
  return getCurrencyDecimals(code);
}
