/**
 * platformUsd.ts — platform-billing normalisation to USD (ADR 0136).
 *
 * Platform billing (subscription payments, plan prices) settles in USD; USD is
 * the canonical unit of the platform's own P&L, not a tenant's base currency.
 * The rows come from `platform_exchange_rates` (market data), never from a
 * tenant's accounting rate book.
 *
 * This module owns no lookup logic of its own: it maps the platform rows onto
 * the rate-book shape and delegates to the single client resolver. A pair with
 * no rate on file yields `null` — never the unconverted amount, which would be
 * a silent 1:1.
 */
import { resolveRateFromBook, type RateBookRow } from "./rateBook";

export interface PlatformRateRow {
  from_currency: string;
  to_currency: string;
  rate: number | string;
  created_at?: string | null;
}

function toBookRows(rates: PlatformRateRow[] | null | undefined): RateBookRow[] {
  return (rates ?? []).map((r) => ({
    from_currency: r.from_currency,
    to_currency: r.to_currency,
    rate: r.rate,
    effective_date: (r.created_at ?? "").split("T")[0] || "1970-01-01",
    source: "provider",
  }));
}

/** `null` when the pair has no rate on file. Never returns the input amount. */
export function toPlatformUsd(
  amount: number,
  from: string | null | undefined,
  rates: PlatformRateRow[] | null | undefined,
): number | null {
  const code = (from || "").toUpperCase();
  if (!code) return null;
  const rate = resolveRateFromBook(toBookRows(rates), code, "USD", undefined, "USD");
  return rate === null ? null : amount * rate;
}

/**
 * Sum a set of amounts into USD. Amounts whose currency has no rate on file are
 * excluded from `total` and reported in `unconvertible` so the caller can say so
 * rather than quietly under- or over-stating the figure.
 */
export function sumPlatformUsd(
  entries: Array<{ amount: number; currency: string | null | undefined }>,
  rates: PlatformRateRow[] | null | undefined,
): { total: number; unconvertible: number } {
  let total = 0;
  let unconvertible = 0;
  for (const e of entries) {
    const converted = toPlatformUsd(e.amount, e.currency, rates);
    if (converted === null) unconvertible += 1;
    else total += converted;
  }
  return { total, unconvertible };
}
