/**
 * Inventory quantity display primitives.
 *
 * The inventory engine stores everything in BASE units. Packs (Box, Carton,
 * Strip, …) are pure presentation: derived from `product_packaging` rows
 * (`name`, `qty_in_base_uom`).
 *
 * Every cell that renders a `warehouse_stock.quantity`, a movement qty, or
 * an "on-hand" tile should funnel through these helpers so behavior stays
 * consistent across listings, drawers, panels, and reports.
 */

export interface PackForRollup {
  /** `product_packaging.id` — required by capture surfaces that must send
   *  the packaging level to the server for conversion. Optional here so
   *  display-only callers can keep building lightweight rollups. */
  id?: string;
  name: string;
  qty_in_base_uom: number;
}


/** "240 ea" — base only, no pack rollup. */
export function formatBaseQty(qty: number, baseLabel = "ea"): string {
  const n = Number.isFinite(qty) ? qty : 0;
  return `${Number(n.toFixed(3))} ${baseLabel}`;
}

/**
 * Largest-pack rollup with remainder in base units.
 *   formatQtyAsPacks(50, [{name:"Box",qty_in_base_uom:24}], "ea")
 *     → "2 Box + 2 ea"
 *   formatQtyAsPacks(48, [{name:"Box",qty_in_base_uom:24}], "ea")
 *     → "2 Box"
 */
export function formatQtyAsPacks(
  qty: number,
  packs: PackForRollup[],
  baseLabel = "ea",
): string {
  if (!Number.isFinite(qty) || qty <= 0) return formatBaseQty(0, baseLabel);
  const sorted = [...packs]
    .filter((p) => p && Number(p.qty_in_base_uom) > 1 && p.name)
    .sort((a, b) => b.qty_in_base_uom - a.qty_in_base_uom);
  for (const p of sorted) {
    const whole = Math.floor(qty / p.qty_in_base_uom);
    if (whole >= 1) {
      const remainder = qty - whole * p.qty_in_base_uom;
      if (remainder <= 0.0001) return `${whole} ${p.name}`;
      const rem = Number(remainder.toFixed(3));
      return `${whole} ${p.name} + ${rem} ${baseLabel}`;
    }
  }
  return formatBaseQty(qty, baseLabel);
}

/**
 * Display string that combines pack rollup AND base figure for clarity.
 *   formatQtyWithPacks(240, [{name:"Box",qty_in_base_uom:24}], "ea")
 *     → "10 Box (240 ea)"
 * Falls back to base-only when no pack fits or no packs are configured.
 */
export function formatQtyWithPacks(
  qty: number,
  packs: PackForRollup[] | null | undefined,
  baseLabel = "ea",
): string {
  const base = formatBaseQty(qty, baseLabel);
  if (!packs || packs.length === 0 || !Number.isFinite(qty) || qty <= 0) {
    return base;
  }
  const pack = formatQtyAsPacks(qty, packs, baseLabel);
  return pack === base ? base : `${pack} (${base})`;
}

/**
 * Full decomposition across all configured packs, largest first.
 * Used by the "convert" tool in the Units & Packaging tab.
 *   decomposeQty(75, [{name:"Box",qty_in_base_uom:24},{name:"Pack",qty_in_base_uom:6}], "ea")
 *     → [{name:"Box",count:3},{name:"Pack",count:0},{name:"ea",count:3}]
 */
export function decomposeQty(
  qty: number,
  packs: PackForRollup[],
  baseLabel = "ea",
): Array<{ name: string; count: number }> {
  const out: Array<{ name: string; count: number }> = [];
  if (!Number.isFinite(qty) || qty <= 0) return [{ name: baseLabel, count: 0 }];
  const sorted = [...packs]
    .filter((p) => Number(p.qty_in_base_uom) > 1 && p.name)
    .sort((a, b) => b.qty_in_base_uom - a.qty_in_base_uom);
  let remaining = qty;
  for (const p of sorted) {
    const whole = Math.floor(remaining / p.qty_in_base_uom);
    out.push({ name: p.name, count: whole });
    remaining -= whole * p.qty_in_base_uom;
  }
  out.push({ name: baseLabel, count: Number(remaining.toFixed(3)) });
  return out;
}

/**
 * Format a quantity that came from a transaction line WITH pack
 * provenance — used by receipts, invoice PDFs, document templates.
 *
 *   formatTransactionQty(1, "Box", 10, "ea")           → "1 Box (10 ea)"
 *   formatTransactionQty(1, "Box", 10, "ea", { showBase: false }) → "1 Box"
 *   formatTransactionQty(10, null, 10, "ea")           → "10 ea"
 */
export function formatTransactionQty(
  displayQty: number,
  packagingLabel: string | null | undefined,
  baseQty: number,
  baseLabel = "ea",
  opts: { showBase?: boolean } = {},
): string {
  const showBase = opts.showBase !== false;
  const dq = Number.isFinite(displayQty) ? Number(displayQty.toFixed(3)) : 0;
  const bq = Number.isFinite(baseQty) ? Number(baseQty.toFixed(3)) : 0;
  if (packagingLabel && packagingLabel.trim().length > 0) {
    const head = `${dq} ${packagingLabel.trim()}`;
    return showBase && bq !== dq ? `${head} (${bq} ${baseLabel})` : head;
  }
  return `${bq} ${baseLabel}`;
}
