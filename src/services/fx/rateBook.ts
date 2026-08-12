/**
 * rateBook.ts — the ONE client-side rate lookup (ADR 0136).
 *
 * There is exactly one rate book: `public.exchange_rates`. This module mirrors
 * the precedence of the server-side `public.resolve_exchange_rate`
 * (override > manual > provider, most recent effective date first) for
 * DISPLAY purposes only.
 *
 * Rules:
 *   - It NEVER invents 1 for a missing pair. `null` means "no rate on file"
 *     and the caller must render an honest missing-rate state.
 *   - It never posts, and no accounting amount may be derived from it.
 *     Booking/settlement rates are stamped server-side by document triggers
 *     and the settlement engines.
 */

export interface RateBookRow {
  from_currency: string;
  to_currency: string;
  rate: number | string;
  effective_date: string;
  source?: string | null;
}

const SOURCE_RANK: Record<string, number> = { override: 0, manual: 1, provider: 2 };

function rankSource(source?: string | null): number {
  return SOURCE_RANK[(source ?? "provider").toLowerCase()] ?? 3;
}

/** Best row for an exact ordered pair as of `asOf`, or null. */
function pickPair(
  rows: RateBookRow[],
  from: string,
  to: string,
  asOf: string,
): number | null {
  let best: RateBookRow | null = null;
  for (const r of rows) {
    if ((r.from_currency || "").toUpperCase() !== from) continue;
    if ((r.to_currency || "").toUpperCase() !== to) continue;
    if (r.effective_date > asOf) continue;
    if (
      !best ||
      r.effective_date > best.effective_date ||
      (r.effective_date === best.effective_date && rankSource(r.source) < rankSource(best.source))
    ) {
      best = r;
    }
  }
  const value = best ? Number(best.rate) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Resolve `from → to` as of `asOf` (ISO date), triangulating through `pivot`
 * (the business base currency — the anchor every published row is expressed
 * against). Returns `null` when no path exists.
 */
export function resolveRateFromBook(
  rows: RateBookRow[] | null | undefined,
  from: string,
  to: string,
  asOf?: string,
  pivot?: string | null,
): number | null {
  const f = (from || "").toUpperCase();
  const t = (to || "").toUpperCase();
  if (!f || !t) return null;
  if (f === t) return 1;

  const list = rows ?? [];
  const date = asOf || new Date().toISOString().split("T")[0];

  const direct = pickPair(list, f, t, date);
  if (direct !== null) return direct;

  const reverse = pickPair(list, t, f, date);
  if (reverse !== null) return 1 / reverse;

  const anchor = (pivot || "").toUpperCase();
  if (anchor && f !== anchor && t !== anchor) {
    const fToAnchor = pickPair(list, f, anchor, date) ?? invert(pickPair(list, anchor, f, date));
    const tToAnchor = pickPair(list, t, anchor, date) ?? invert(pickPair(list, anchor, t, date));
    if (fToAnchor !== null && tToAnchor !== null && tToAnchor !== 0) {
      return fToAnchor / tToAnchor;
    }
  }

  return null;
}

function invert(value: number | null): number | null {
  return value !== null && value !== 0 ? 1 / value : null;
}

/** Convert for display. `null` = no rate on file; never a silent 1:1. */
export function convertWithBook(
  rows: RateBookRow[] | null | undefined,
  amount: number,
  from: string,
  to: string,
  asOf?: string,
  pivot?: string | null,
): number | null {
  const rate = resolveRateFromBook(rows, from, to, asOf, pivot);
  return rate === null ? null : amount * rate;
}
