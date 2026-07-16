/**
 * OutboundLineTracking — Phase A.3 shared cell for outbound document
 * line editors (invoice, credit note, sales return, delivery note).
 *
 * Reads `products.is_lot_tracked` / `is_serial_tracked` for the given
 * `productId` and renders the appropriate picker(s):
 *
 *  - lot-tracked → `LotPickerPopover` (FEFO suggestion + operator override)
 *  - serial-tracked → `SerialPickerPopover`
 *  - both → both, side-by-side
 *  - neither → renders nothing (line stays clean for untracked products)
 *
 * Purely presentational. The caller receives lot/serial payloads via
 * `onLotChange` / `onSerialChange` and is responsible for stamping them
 * onto the outbound line at post time. Backend guards (ADR 0066/0067)
 * remain the source of truth — this component prevents users from
 * hitting those guards mid-post.
 *
 * Business / warehouse context is resolved from `BusinessContext` and
 * the current branch's `default_warehouse_id`, so callers only need to
 * pass `productId` + `quantity`.
 */
import { useMemo } from "react";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { useProductTrackingFlags } from "@/hooks/useProductTrackingFlags";
import { LotPickerPopover, type LotAllocationPayload } from "./LotPickerPopover";
import { SerialPickerPopover, type SerialRow } from "./SerialPickerPopover";

interface Props {
  productId: string | null | undefined;
  /** Line quantity in base units. */
  quantity: number;
  /** Optional pack label — passed through to the lot picker for display. */
  packLabel?: string | null;
  packMultiplier?: number | null;
  /** Business / warehouse overrides if the caller has explicit context. */
  businessId?: string | null;
  warehouseId?: string | null;
  onLotChange?: (allocations: LotAllocationPayload[]) => void;
  onSerialChange?: (serialIds: string[], rows: SerialRow[]) => void;
  selectedSerialIds?: string[];
  excludeSerialIds?: string[];
  disabled?: boolean;
}

export function OutboundLineTracking({
  productId,
  quantity,
  packLabel,
  packMultiplier,
  businessId,
  warehouseId,
  onLotChange,
  onSerialChange,
  selectedSerialIds,
  excludeSerialIds,
  disabled,
}: Props) {
  const { currentBusiness } = useBusinesses();
  const { currentBranch } = useBranch();
  const businessIdResolved = businessId ?? currentBusiness?.id ?? null;
  const warehouseIdResolved =
    warehouseId ?? currentBranch?.default_warehouse_id ?? null;

  const productIds = useMemo(
    () => (productId ? [productId] : []),
    [productId],
  );
  const { get } = useProductTrackingFlags(productIds);
  const flags = get(productId);

  if (!productId) return null;
  if (!flags.is_lot_tracked && !flags.is_serial_tracked) return null;
  if (!(quantity > 0)) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {flags.is_lot_tracked && (
        <LotPickerPopover
          businessId={businessIdResolved}
          warehouseId={warehouseIdResolved}
          productId={productId}
          requiredQty={quantity}
          onChange={onLotChange}
          packLabel={packLabel ?? undefined}
          packMultiplier={packMultiplier ?? undefined}
          disabled={disabled}
        />
      )}
      {flags.is_serial_tracked && (
        <SerialPickerPopover
          businessId={businessIdResolved}
          warehouseId={warehouseIdResolved}
          productId={productId}
          requiredQty={quantity}
          value={selectedSerialIds}
          onChange={onSerialChange}
          excludeIds={excludeSerialIds}
          disabled={disabled}
        />
      )}
    </div>
  );
}
