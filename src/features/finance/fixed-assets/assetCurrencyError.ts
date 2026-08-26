/**
 * Translate the database's currency/FX refusals on `fixed_assets` into
 * messages a finance user can act on.
 *
 * The refusals come from the one FX engine through
 * `trg_fixed_assets_stamp_currency`. They are deliberate: a foreign asset
 * with no rate on file is refused rather than recorded at face value, and a
 * depreciated or posted acquisition is frozen. The UI must explain them, not
 * work around them.
 */
export function describeAssetCurrencyError(err: unknown): Error {
  const e = err as { code?: string; message?: string } | null;
  const raw = e?.message ?? "";

  if (e?.code === "23514" && /exchange rate/i.test(raw)) {
    return new Error(
      `${raw}. Record a dated exchange rate for that currency and purchase date in Currency Settings (a reason is required), then save the asset again.`,
    );
  }

  if (/frozen|immutable|depreciat/i.test(raw) && /acquisition|currency|rate/i.test(raw)) {
    return new Error(
      `${raw}. The acquisition currency, date and cost are historical measurements and cannot be changed once the asset has been depreciated or posted.`,
    );
  }

  return err instanceof Error ? err : new Error(raw || "Could not save the asset.");
}
