/**
 * Shared line-item UoM / SKU projection for document snapshots.
 *
 * Why this exists: every `*_items` table stores packaging and unit-of-measure
 * *by reference* (`packaging_id`, `display_uom_id`, `display_quantity`,
 * `uom_snapshot`) and the SKU lives on `products`. Snapshot fetchers used to
 * select flat columns (`sku`, `pack_quantity`, `pack_size`,
 * `unit_of_measure`) that exist on **no** item table — PostgREST answered
 * every one of those requests with `400 column ..._1.pack_quantity does not
 * exist`, which is why "Print" failed across Sales and Purchases.
 *
 * One projection + one normalizer keeps all snapshot builders honest: add a
 * column here, every document kind picks it up.
 */

/** Embed clause appended to every item selection in a snapshot fetcher. */
export const LINE_ITEM_UOM_SELECT = `
  display_quantity, uom_snapshot,
  packaging:product_packaging!packaging_id(name, qty_in_base_uom),
  display_uom:units_of_measure!display_uom_id(code, name),
  product:products(sku, base_uom:units_of_measure!base_uom_id(code, name))
`;

export interface RawLineItemUom {
  quantity?: number | null;
  display_quantity?: number | null;
  uom_snapshot?: string | { code?: string | null; name?: string | null } | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  display_uom?: { code: string | null; name: string | null } | null;
  product?: {
    sku?: string | null;
    base_uom?: { code: string | null; name: string | null } | null;
  } | null;
  /** delivery_note_items carries a denormalized SKU snapshot. */
  product_sku_snapshot?: string | null;
}

export interface NormalizedLineItemUom {
  sku: string | null;
  pack_quantity: number | null;
  pack_size: number | null;
  unit_of_measure: string | null;
}

/**
 * Flattens the reference-shaped row into the four fields the pure snapshot
 * builders (and the renderers downstream) expect. Pure and deterministic.
 */
export function normalizeLineItemUom(row: RawLineItemUom): NormalizedLineItemUom {
  const snapshotUom =
    typeof row.uom_snapshot === "string"
      ? row.uom_snapshot
      : row.uom_snapshot?.code ?? row.uom_snapshot?.name ?? null;

  return {
    sku: row.product_sku_snapshot ?? row.product?.sku ?? null,
    pack_quantity: row.display_quantity == null ? null : Number(row.display_quantity),
    pack_size:
      row.packaging?.qty_in_base_uom == null
        ? null
        : Number(row.packaging.qty_in_base_uom),
    unit_of_measure:
      row.packaging?.name ??
      row.display_uom?.code ??
      snapshotUom ??
      row.product?.base_uom?.code ??
      null,
  };
}

/** Convenience: merge the normalized UoM fields back onto an item row. */
export function withLineItemUom<T extends RawLineItemUom>(
  row: T,
): T & NormalizedLineItemUom {
  return { ...row, ...normalizeLineItemUom(row) };
}

/**
 * Flattens the item collection on a fetched header row so the pure builders
 * keep seeing `sku` / `pack_quantity` / `pack_size` / `unit_of_measure`.
 * `itemsKey` differs per document kind (`items`, `invoice_items`, ...).
 */
export function normalizeSnapshotItems<T extends Record<string, unknown>>(
  row: T,
  itemsKey: string,
): T {
  const raw = row[itemsKey];
  if (!Array.isArray(raw)) return row;
  return { ...row, [itemsKey]: raw.map((i) => withLineItemUom(i as RawLineItemUom)) };
}
