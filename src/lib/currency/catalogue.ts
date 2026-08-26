/**
 * currencyCatalogue (client mirror) — the ONE source of currency presentation
 * facts: how many minor units a currency has, and what symbol it prints with.
 *
 * Phase 7 of the currency-architecture remediation replaced the hardcoded
 * "always two decimals" assumption and the per-module symbol maps with this
 * catalogue. A JPY, KRW, RWF or CLP amount is a whole-unit amount: printing
 * `¥ 1,200.00` is wrong, not cosmetic.
 *
 * Layers, in precedence order:
 *   1. Runtime catalogue — rows loaded from `public.currencies`
 *      (`code`, `symbol`, `decimal_places`), installed by `CurrencyProvider`.
 *      This is the tenant-authoritative answer.
 *   2. ISO 4217 minor units — a static, standards-derived table used before
 *      the rows arrive and for any code the tenant catalogue does not carry.
 *   3. Fallbacks — two decimals, and the ISO code itself as the symbol.
 *
 * This module is deliberately pure and synchronous: formatters are called
 * inside render paths and must never await. It mirrors, entry for entry,
 * `supabase/functions/_shared/format/catalogue.ts`; a parity test pins the
 * two together.
 *
 * NEVER put arithmetic here. Presentation only.
 */

/** ISO 4217 currencies whose minor unit is not 2. Everything else is 2. */
export const ISO_MINOR_UNITS: Record<string, number> = {
  // Zero-decimal currencies
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, IDR: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal currencies
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

/** Symbols used before the tenant catalogue loads (and for unknown codes). */
export const SEED_SYMBOLS: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥",
  KES: "KSh", UGX: "USh", TZS: "TSh", NGN: "₦",
  ZAR: "R", GHS: "GH₵", INR: "₹", AUD: "A$", CAD: "C$",
  CHF: "CHF", SEK: "kr", NOK: "kr", DKK: "kr",
  BRL: "R$", MXN: "Mex$", ARS: "AR$", COP: "$",
  AED: "د.إ", SAR: "﷼", QAR: "ر.ق", KWD: "د.ك",
  SGD: "S$", HKD: "HK$", NZD: "NZ$", PHP: "₱", THB: "฿",
  MYR: "RM", IDR: "Rp", VND: "₫", KRW: "₩", TWD: "NT$",
  EGP: "E£", MAD: "MAD", XOF: "CFA", XAF: "FCFA",
  RWF: "RF", ETB: "Br", BWP: "P", MWK: "MK", ZMW: "ZK",
};

export interface CurrencyCatalogueRow {
  code: string;
  symbol?: string | null;
  decimal_places?: number | null;
}

const runtime = new Map<string, { symbol: string; decimals: number }>();

/**
 * Install the tenant catalogue (rows from `public.currencies`). Called once
 * by `CurrencyProvider`; safe to call again when the catalogue is refreshed.
 */
export function setCurrencyCatalogue(rows: CurrencyCatalogueRow[]): void {
  runtime.clear();
  for (const row of rows) {
    if (!row?.code) continue;
    const code = row.code.toUpperCase();
    runtime.set(code, {
      symbol: (row.symbol || "").trim() || code,
      decimals:
        typeof row.decimal_places === "number" && row.decimal_places >= 0
          ? row.decimal_places
          : isoDecimals(code),
    });
  }
}

/** Test/teardown hook. */
export function resetCurrencyCatalogue(): void {
  runtime.clear();
}

function isoDecimals(code: string): number {
  return ISO_MINOR_UNITS[code] ?? 2;
}

/** Minor units for a currency — catalogue first, then ISO, then 2. */
export function getCurrencyDecimals(code?: string | null): number {
  if (!code) return 2;
  const upper = code.toUpperCase();
  return runtime.get(upper)?.decimals ?? isoDecimals(upper);
}

/** Bare symbol, no spacing applied. Empty when no currency is known. */
export function getCurrencySymbol(code?: string | null): string {
  if (!code) return "";
  const upper = code.toUpperCase();
  return runtime.get(upper)?.symbol ?? SEED_SYMBOLS[upper] ?? upper;
}

/**
 * Symbol as a prefix: alphabetic/abbreviated symbols get a separating space
 * (`KSh 1,200.00`), true glyphs do not (`$1,200.00`).
 */
export function getCurrencyPrefix(code?: string | null): string {
  const symbol = getCurrencySymbol(code);
  if (!symbol) return "";
  return /[\p{L}.]$/u.test(symbol) ? `${symbol} ` : symbol;
}

/** Grouped number with the currency's own minor units. No symbol. */
export function formatCurrencyDigits(value: number, code?: string | null): string {
  const decimals = getCurrencyDecimals(code);
  return Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
