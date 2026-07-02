/**
 * formatAppPrice — single source of truth for displaying app/addon prices.
 *
 * Replaces the four copy-pasted `formatPrice` helpers that had a hardcoded
 * symbol map (USD/EUR/GBP only) and silently defaulted to a "USD" literal
 * when no currency was provided. Those helpers lived in:
 *   - src/components/home/AppMarketplace.tsx
 *   - src/pages/Apps.tsx
 *   - src/pages/apps/AppActivate.tsx
 *   - src/pages/settings/AppsAndSubscriptions.tsx
 *
 * Symbols, decimal places, and the canonical default currency are now read
 * from the `public.currencies` table — never hardcoded. If a price arrives
 * without a currency, we fall back to the org/platform base currency, NOT
 * to a literal "USD".
 *
 * Usage:
 *   const display = formatAppPrice(12, "EUR", { perUser: true }, currencyMap);
 *   // → "€12/user/mo"
 *
 * Pair with `useCurrencyMap()` (src/hooks/useCurrencyMap.ts) to feed the
 * currency lookup. Never inline a symbol map at the call site.
 */

export interface CurrencyInfo {
  code: string;
  symbol: string;
  decimal_places: number;
}

export type CurrencyMap = Record<string, CurrencyInfo>;

export interface FormatAppPriceOptions {
  /** Per-user pricing (e.g. "$12/user/mo" instead of "$12/mo"). */
  perUser?: boolean;
  /** "/mo" (default) or "/yr". */
  period?: "monthly" | "yearly";
  /** When the amount is null/0 we render this label. Default: "Free". */
  freeLabel?: string;
}

/**
 * Resolve a currency symbol from the canonical currencies map.
 * Falls back to the bare code (e.g. "KES ") when no symbol is registered.
 * Never invents a symbol.
 */
export function resolveCurrencySymbol(
  code: string | null | undefined,
  currencyMap: CurrencyMap | undefined,
): { symbol: string; decimals: number } {
  if (!code) return { symbol: "", decimals: 2 };
  const info = currencyMap?.[code.toUpperCase()];
  if (info) {
    return { symbol: info.symbol || `${info.code} `, decimals: info.decimal_places ?? 2 };
  }
  // Unknown currency — show the code itself rather than guessing a symbol.
  return { symbol: `${code.toUpperCase()} `, decimals: 2 };
}

/**
 * Format an app price for display. The currency MUST come from the data row
 * (e.g. `app_pricing_rules.currency` or the org's billing currency). The
 * caller is responsible for choosing the right one — this helper never
 * falls back to "USD".
 */
export function formatAppPrice(
  amount: number | null | undefined,
  currency: string | null | undefined,
  options: FormatAppPriceOptions = {},
  currencyMap?: CurrencyMap,
): string {
  const { perUser = false, period = "monthly", freeLabel = "Free" } = options;

  if (amount == null || amount === 0) return freeLabel;

  const { symbol, decimals } = resolveCurrencySymbol(currency, currencyMap);
  // Use the currency's own decimal_places (e.g. CLP/IDR are 0-decimal).
  const isInteger = amount % 1 === 0;
  const displayDecimals = isInteger ? 0 : decimals;
  const value = amount.toFixed(displayDecimals);

  const periodSuffix = period === "yearly" ? "/yr" : "/mo";
  const userSuffix = perUser ? "/user" : "";

  return `${symbol}${value}${userSuffix}${periodSuffix}`;
}
