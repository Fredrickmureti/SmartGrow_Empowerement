/**
 * useSalesWarehouse — the ONE way a Sales editor chooses the warehouse a
 * document will draw stock from.
 *
 * Phase 6b of the Sales domain wave. Availability was being read as a *branch
 * aggregate* while reservations and goods issue happen against a *single
 * warehouse*: an operator could see 30 available across two warehouses and
 * commit 30 from one that only holds 12. The warehouse is therefore a recorded
 * decision on the document (`sales_orders.warehouse_id`,
 * `invoices.warehouse_id`, `delivery_notes.warehouse_id`), resolved and
 * validated server-side by `public.resolve_sales_warehouse`.
 *
 * The client's only job is to let the operator pick among the warehouses the
 * active branch can legitimately ship from, and to send that id. The server
 * still validates it and falls back to the branch default when it is null, so
 * this hook is a convenience — never an authority.
 */
import { useEffect, useMemo, useState } from "react";
import { useWarehouses, type Warehouse } from "@/hooks/useWarehouses";

export interface SalesWarehouseSelection {
  /** The chosen warehouse, or null to let the server pick the branch default. */
  warehouseId: string | null;
  setWarehouseId: (id: string | null) => void;
  /** Warehouses the active branch may ship from. */
  options: Warehouse[];
  /** True when there is nothing to choose — hide the field. */
  hidden: boolean;
  /** Name of the current selection, for scope labels. */
  selectedName: string | null;
}

export function useSalesWarehouse(): SalesWarehouseSelection {
  const { activeWarehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState<string | null>(null);

  const options = useMemo(
    () =>
      [...(activeWarehouses ?? [])].sort((a, b) => {
        if (!!a.is_default !== !!b.is_default) return a.is_default ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [activeWarehouses],
  );

  // Preselect the branch default so the operator reads the numbers the server
  // will actually reserve against, instead of a branch-wide aggregate.
  useEffect(() => {
    if (warehouseId || options.length === 0) return;
    const preferred = options.find((w) => w.is_default) ?? options[0];
    if (preferred) setWarehouseId(preferred.id);
  }, [options, warehouseId]);

  // A stale selection (branch switch) must not survive.
  useEffect(() => {
    if (warehouseId && !options.some((w) => w.id === warehouseId)) {
      setWarehouseId(null);
    }
  }, [options, warehouseId]);

  return {
    warehouseId,
    setWarehouseId,
    options,
    hidden: options.length <= 1,
    selectedName: options.find((w) => w.id === warehouseId)?.name ?? null,
  };
}
