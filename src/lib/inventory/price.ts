/**
 * Per-pack price / cost derivation — single source of truth.
 *
 * Mirrors the SQL functions `public.product_pack_price(p_id, pkg_id)` and
 * `public.product_pack_cost(p_id, pkg_id)`:
 *
 *   pack_price = unit_price * coalesce(qty_in_base_uom, 1)
 *   pack_cost  = cost_price * coalesce(qty_in_base_uom, 1)
 *
 * Always call this helper instead of inlining the multiplication so the TS
 * client and the SQL server agree on every per-pack figure (POS, quotes,
 * estimates, reorder rules, valuation reports).
 *
 * For an explicit per-pack override the caller should consult
 * `product_pricing` first and fall back to `derivePackPrice` only when no
 * row matches.
 */
export function derivePackPrice(
  unitPriceInBase: number,
  qtyInBaseUom: number | null | undefined,
): number {
  const u = Number(unitPriceInBase);
  if (!Number.isFinite(u)) return 0;
  const f = Number(qtyInBaseUom);
  if (!Number.isFinite(f) || f <= 0) return u;
  return u * f;
}

/**
 * Identical formula for cost — kept as a separate export so call sites
 * read self-documenting (`derivePackCost(...)`) rather than re-using the
 * price helper with a misleading variable name.
 */
export function derivePackCost(
  costPriceInBase: number,
  qtyInBaseUom: number | null | undefined,
): number {
  return derivePackPrice(costPriceInBase, qtyInBaseUom);
}
