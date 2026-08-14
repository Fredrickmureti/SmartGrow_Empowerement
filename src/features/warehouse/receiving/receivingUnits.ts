/**
 * receivingUnits — the unit vocabulary shared by every warehouse capture
 * surface (receiving, counts, returns).
 *
 * IMPORTANT (Phase 1 — server-authoritative units). The browser NO LONGER
 * converts packaging quantities to base units for the ledger. A surface sends
 * `{ p_packaging_id, p_entered_qty }` and the server derives the base quantity
 * through `wms_to_base_qty()`, which reads the product's own
 * `product_packaging.qty_in_base_uom`. `toBaseUnits()` below survives only as a
 * DISPLAY PREVIEW ("= 500 kg") — never pass its result into a `wms_*` RPC as a
 * quantity argument.
 */
import { useMemo } from "react";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import type { PackForRollup } from "@/lib/inventory/formatQty";

export interface ReceivingUnitOption {
  /** Stable select value. `base` for the ledger unit, else the packaging id. */
  key: string;
  /** Operator-facing label ("ea", "Case × 12"). */
  label: string;
  /** Audit label persisted alongside the line. */
  uom: string;
  /** `product_packaging.id`, or null for the base ledger unit. */
  packagingId: string | null;
  /** Base ledger units in ONE of this unit — PREVIEW ONLY. */
  qtyInBaseUom: number;
  isBase: boolean;
}

export const BASE_UNIT_KEY = "base";

/** Base unit first, then packs smallest → largest. Duplicates collapse. */
export function unitOptionsFor(
  packs: ReadonlyArray<PackForRollup> | undefined,
  baseLabel = "ea",
): ReceivingUnitOption[] {
  const base: ReceivingUnitOption = {
    key: BASE_UNIT_KEY,
    label: baseLabel,
    uom: baseLabel,
    packagingId: null,
    qtyInBaseUom: 1,
    isBase: true,
  };
  const seen = new Set<string>();
  const rest = (packs ?? [])
    .filter((p) => p?.name && Number(p.qty_in_base_uom) > 1)
    .sort((a, b) => Number(a.qty_in_base_uom) - Number(b.qty_in_base_uom))
    .filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)))
    .map<ReceivingUnitOption>((p) => ({
      key: p.id ?? p.name,
      label: `${p.name} × ${Number(p.qty_in_base_uom)}`,
      uom: p.name,
      packagingId: p.id ?? null,
      qtyInBaseUom: Number(p.qty_in_base_uom),
      isBase: false,
    }));
  return [base, ...rest];
}

/**
 * PREVIEW ONLY — show the operator what their typed quantity means in base
 * units. The authoritative conversion happens in `wms_to_base_qty()`.
 */
export function toBaseUnits(qty: number, option: ReceivingUnitOption | undefined): number {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const factor = Number(option?.qtyInBaseUom ?? 1);
  return Number((n * (Number.isFinite(factor) && factor > 0 ? factor : 1)).toFixed(3));
}


/** Find an option by key, falling back to the base unit. */
export function optionByKey(
  options: ReadonlyArray<ReceivingUnitOption>,
  key: string,
): ReceivingUnitOption {
  return options.find((o) => o.key === key) ?? options[0]!;
}

/**
 * Per-product unit options for a receiving surface, batched in one query.
 * `baseLabels` lets a caller supply the product's base UoM code when known;
 * otherwise "ea" is used as the neutral ledger label.
 */
export function useReceivingUnitOptions(
  productIds: ReadonlyArray<string>,
  baseLabels?: ReadonlyMap<string, string>,
): Map<string, ReceivingUnitOption[]> {
  const ids = useMemo(
    () => Array.from(new Set(productIds.filter(Boolean))).sort(),
    [productIds],
  );
  const { packsByProduct } = useProductPackagingBatch(ids);
  return useMemo(() => {
    const out = new Map<string, ReceivingUnitOption[]>();
    for (const id of ids) {
      out.set(id, unitOptionsFor(packsByProduct.get(id), baseLabels?.get(id) ?? "ea"));
    }
    return out;
  }, [ids, packsByProduct, baseLabels]);
}
