/**
 * receivingUnits — the single conversion seam between what an operator types
 * on a receiving surface and what the ledger stores (Receiving audit, Phase 11).
 *
 * The Inventory engine stores BASE units only (see the multi-unit display
 * contract). `product_packaging` rows are a presentation layer: "Case × 12" is
 * a label over 12 base units. Scanned captures already resolve the packaging
 * level through `useWmsIdentityGate` (`scanToBaseUnits`), so a GS1 case scan
 * books 12. Typed captures had no such path — an operator entering "5" while
 * holding five cases booked five each.
 *
 * Every receiving surface therefore selects a unit and converts here. Nothing
 * downstream of this module may reason in pack quantities.
 */
import { useMemo } from "react";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import type { PackForRollup } from "@/lib/inventory/formatQty";

export interface ReceivingUnitOption {
  /** Stable select value. `base` for the ledger unit, else the pack name. */
  key: string;
  /** Operator-facing label ("ea", "Case × 12"). */
  label: string;
  /** Value persisted on `wms_receiving_lines.uom` for audit. */
  uom: string;
  /** Base ledger units in ONE of this unit. */
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
    qtyInBaseUom: 1,
    isBase: true,
  };
  const seen = new Set<string>();
  const rest = (packs ?? [])
    .filter((p) => p?.name && Number(p.qty_in_base_uom) > 1)
    .sort((a, b) => Number(a.qty_in_base_uom) - Number(b.qty_in_base_uom))
    .filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)))
    .map<ReceivingUnitOption>((p) => ({
      key: p.name,
      label: `${p.name} × ${Number(p.qty_in_base_uom)}`,
      uom: p.name,
      qtyInBaseUom: Number(p.qty_in_base_uom),
      isBase: false,
    }));
  return [base, ...rest];
}

/**
 * Convert a typed quantity in the chosen unit to base ledger units.
 * Non-finite or negative input collapses to 0 — the RPC rejects negatives, and
 * a surface must never guess.
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
