/**
 * warehouseQty — the ONE display seam for warehouse quantities.
 *
 * Phase 1 of this wave made the *conversion* server-authoritative
 * (`wms_to_base_qty`). Phase 2.4 makes the *presentation* truthful: a warehouse
 * screen must never print a naked base-unit integer, because an operator who
 * received "10 Bags" and then reads `500` on the review grid is one keystroke
 * away from a wrong count.
 *
 * Rules for every warehouse surface:
 *   - No local conversion maths. Pack factors come from `product_packaging`
 *     through `useProductPackagingBatch`; the strings come from the canonical
 *     `@/lib/inventory/formatQty` helpers. This module only *delegates*.
 *   - No hardcoded unit words ("ea", "pcs", "units") in JSX. Pass the product's
 *     base UoM label in, or let the formatter fall back.
 *   - Quantities with pack provenance (an operator typed 10 × Bag) render
 *     through `formatTransactionQty` so both the typed figure and the ledger
 *     figure stay visible.
 *
 * Pinned by `src/test/architecture/warehouse-qty-display.test.ts`.
 */
import { useMemo } from "react";
import { useProductPackagingBatch } from "@/hooks/inventory/useProductPackagingBatch";
import {
  formatBaseQty,
  formatQtyWithPacks,
  formatQtyAsPacks,
  formatTransactionQty,
  type PackForRollup,
} from "@/lib/inventory/formatQty";

/** Neutral ledger label used when a product's base UoM code isn't loaded. */
export const NEUTRAL_BASE_LABEL = "ea";

export interface WarehouseQtyOptions {
  /** Override the product's base UoM label for this one call. */
  baseLabel?: string;
  /** `false` → pack rollup only ("10 Bag"), no "(500 kg)" tail. */
  showBase?: boolean;
}

export interface EnteredQtyInput {
  /** What the operator typed, in their chosen unit. */
  enteredQty: number | null | undefined;
  /** `product_packaging.name` for that unit, or null when they used base. */
  packagingName: string | null | undefined;
  /** The server-derived base quantity actually booked. */
  baseQty: number | null | undefined;
  baseLabel?: string;
}

export interface WarehouseQtyFormatter {
  isLoading: boolean;
  /** Packaging levels configured for a product (largest-first agnostic). */
  packsFor(productId: string | null | undefined): PackForRollup[];
  /** Base UoM label resolved for a product. */
  baseLabelFor(productId: string | null | undefined): string;
  /**
   * A ledger quantity for one product: "10 Bag (500 kg)".
   * Falls back to "500 kg" when the product has no packaging configured.
   */
  format(
    productId: string | null | undefined,
    baseQty: number | null | undefined,
    opts?: WarehouseQtyOptions,
  ): string;
  /** Signed variance, same unit vocabulary: "+2 Bag (100 kg)" / "-50 kg". */
  formatSigned(
    productId: string | null | undefined,
    baseQty: number | null | undefined,
    opts?: WarehouseQtyOptions,
  ): string;
  /** A captured line with pack provenance: "10 Bag (500 kg)". */
  formatEntered(productId: string | null | undefined, input: EnteredQtyInput): string;
}

/**
 * Batched formatter for a set of products on screen. One query per surface,
 * not per row.
 *
 * @param productIds every product id rendered by the surface
 * @param baseLabels optional productId → base UoM code (e.g. "kg")
 */
export function useWarehouseQtyFormatter(
  productIds: ReadonlyArray<string | null | undefined>,
  baseLabels?: ReadonlyMap<string, string>,
): WarehouseQtyFormatter {
  const ids = useMemo(
    () => Array.from(new Set(productIds.filter((x): x is string => Boolean(x)))).sort(),
    [productIds],
  );
  const { packsByProduct, isLoading } = useProductPackagingBatch(ids);

  return useMemo<WarehouseQtyFormatter>(() => {
    const packsFor = (productId: string | null | undefined): PackForRollup[] =>
      (productId ? packsByProduct.get(productId) : undefined) ?? [];

    const baseLabelFor = (productId: string | null | undefined): string =>
      (productId ? baseLabels?.get(productId) : undefined) ?? NEUTRAL_BASE_LABEL;

    const format: WarehouseQtyFormatter["format"] = (productId, baseQty, opts) => {
      const qty = Number(baseQty ?? 0);
      const label = opts?.baseLabel ?? baseLabelFor(productId);
      if (opts?.showBase === false) {
        return formatQtyAsPacks(qty, packsFor(productId), label);
      }
      return formatQtyWithPacks(qty, packsFor(productId), label);
    };

    const formatSigned: WarehouseQtyFormatter["formatSigned"] = (productId, baseQty, opts) => {
      const qty = Number(baseQty ?? 0);
      const label = opts?.baseLabel ?? baseLabelFor(productId);
      if (qty === 0) return formatBaseQty(0, label);
      const body = format(productId, Math.abs(qty), opts);
      return `${qty < 0 ? "-" : "+"}${body}`;
    };

    const formatEntered: WarehouseQtyFormatter["formatEntered"] = (productId, input) => {
      const label = input.baseLabel ?? baseLabelFor(productId);
      const base = Number(input.baseQty ?? 0);
      if (input.packagingName && input.enteredQty != null) {
        return formatTransactionQty(Number(input.enteredQty), input.packagingName, base, label);
      }
      return format(productId, base, { baseLabel: label });
    };

    return { isLoading, packsFor, baseLabelFor, format, formatSigned, formatEntered };
  }, [packsByProduct, baseLabels, isLoading]);
}

/**
 * A quantity that spans multiple products (a wave total, a labour throughput
 * figure, a damaged-units tally). Pack rollup is meaningless across products,
 * so this prints the base figure with an explicit unit — never a naked number.
 */
export function AggregateQty({
  qty,
  baseLabel = NEUTRAL_BASE_LABEL,
  className,
}: {
  qty: number | null | undefined;
  baseLabel?: string;
  className?: string;
}) {
  return <span className={className}>{formatBaseQty(Number(qty ?? 0), baseLabel)}</span>;
}

/** Render one product's ledger quantity through the formatter. */
export function WarehouseQty({
  fmt,
  productId,
  baseQty,
  enteredQty,
  packagingName,
  baseLabel,
  showBase,
  signed,
  className,
}: {
  fmt: WarehouseQtyFormatter;
  productId: string | null | undefined;
  baseQty: number | null | undefined;
  enteredQty?: number | null;
  packagingName?: string | null;
  baseLabel?: string;
  showBase?: boolean;
  signed?: boolean;
  className?: string;
}) {
  const text =
    packagingName && enteredQty != null
      ? fmt.formatEntered(productId, { enteredQty, packagingName, baseQty, ...(baseLabel ? { baseLabel } : {}) })
      : signed
        ? fmt.formatSigned(productId, baseQty, { ...(baseLabel ? { baseLabel } : {}), ...(showBase === false ? { showBase } : {}) })
        : fmt.format(productId, baseQty, { ...(baseLabel ? { baseLabel } : {}), ...(showBase === false ? { showBase } : {}) });
  return <span className={className}>{text}</span>;
}
