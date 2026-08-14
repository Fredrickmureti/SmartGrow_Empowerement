---
name: wms-handling-unit-invariants
description: License plate (handling unit) invariants — packaging-aware server conversion, mandatory optimistic concurrency, container capacity policy, and the display seam for plate quantities.
type: constraint
---
- A license plate is a WAREHOUSE container (`wms_packaging_types`), never a product packaging level (`product_packaging`). `stock_quants.package_id` is product packaging; `stock_quants.lpn_id` is the handling unit. Never conflate them.
- Every plate mutator requires `_expected_version` and REJECTS a NULL version (`wms_lpn_version_required`, stale → `wms_lpn_stale`): load, unload, split, merge, nest, unnest, move, seal, retire, dispatch, receive_return, set_packaging. Server callers thread the freshly read `row_version`; never re-add a `DEFAULT NULL` or a `COALESCE(_expected_version, row_version)` fallback. Client seam: `LpnAction.expectedVersion` is a required `number`.
- `wms_lpn_load` / `wms_lpn_unload` / `wms_lpn_split` take `_packaging_id` + the entered quantity and convert server-side through `wms_to_base_qty` (which reads `product_packaging.qty_in_base_uom`). The browser never converts to base units — `toBaseUnits()` is preview text only.
- Container capacity: `_wms_lpn_capacity_check` compares plate contents (weights from canonical `product_physical_attributes`, base-unit rows only) plus `wms_packaging_types.tare_weight_kg` against `max_weight_kg`. Blocked with `WMS_LPN_OVER_CAPACITY` when `warehouses.enforce_handling_unit_capacity` is true, otherwise logged to `wms_exceptions`. Missing canonical weights = no assessment; never invent measurements.
- Plate quantities render only through `@/features/warehouse/quantity/warehouseQty` (`WarehouseQty` / `AggregateQty`); no naked base-unit numbers, no hardcoded unit words on plate surfaces.
