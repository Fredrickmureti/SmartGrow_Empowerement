/**
 * Currency formatting — single source of truth for the entire reporting engine.
 *
 * Used by:
 *   - Financial report PDFs (_shared/reportPdfGenerator.ts)
 *   - Sales document PDFs (_shared/pdfGenerator.ts via templateRenderer.ts)
 *   - Payroll PDFs
 *
 * Rules:
 *   - Currency symbol prefixes the value.
 *   - Negatives render in parentheses (accounting convention).
 *   - Two fraction digits, en-US grouping.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥",
  KES: "KES ", KSH: "KSh ", UGX: "UGX ", TZS: "TZS ", NGN: "₦",
  ZAR: "R", GHS: "GH₵", INR: "₹", AUD: "A$", CAD: "C$",
  CHF: "CHF ", SEK: "kr ", NOK: "kr ", DKK: "kr ",
  BRL: "R$", MXN: "MX$", ARS: "ARS ", COP: "COP ",
  AED: "AED ", SAR: "SAR ", QAR: "QAR ", KWD: "KD ",
  SGD: "S$", HKD: "HK$", NZD: "NZ$", PHP: "₱", THB: "฿",
  MYR: "RM ", IDR: "Rp ", VND: "₫", KRW: "₩", TWD: "NT$",
  EGP: "E£", MAD: "MAD ", XOF: "CFA ", XAF: "FCFA ",
  RWF: "RF ", ETB: "Br ", BWP: "P", MWK: "MK ", ZMW: "ZK ",
};

export function getCurrencySymbol(code?: string): string {
  if (!code) return "";
  return CURRENCY_SYMBOLS[code.toUpperCase()] || `${code.toUpperCase()} `;
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
 * Negative: (KES 1,234.56)
 * Positive: KES 1,234.56
 */
export function formatAccountingNumber(value: number, currencyCode?: string): string {
  const symbol = getCurrencySymbol(currencyCode);
  const safe = coerceFinite(value);
  const absVal = Math.abs(safe);
  const formatted = absVal.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (safe < 0) {
    return `(${symbol}${formatted})`;
  }
  return `${symbol}${formatted}`;
}

/**
 * Plain amount (no currency symbol). Negatives keep a minus sign.
 * Used for line totals inside sales documents that already show currency in headers.
 */
export function formatAmount(value: number): string {
  return coerceFinite(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

