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

## Workforce (Phase 7)
- Supervisor mutators `wms_reassign_task`, `wms_release_task`, `wms_set_task_priority`, `wms_set_operator_status` all require `p_row_version` (no DEFAULT); tasks go through `_wms_task_locked` (FOR UPDATE + tenant check + `wms_task_version_required` / `wms_task_stale`), operators raise `wms_operator_*`. `wms_operators.row_version` exists and both boards (`wms_labour_queue_view`, `wms_operator_board_view`) expose `row_version` so the client echoes what it read. Never re-add a blind write or read-then-write inside the RPC.
- Releasing a task emits `warehouse.task.available`; reassignment emits `warehouse.task.assigned`. Workforce failure copy comes from `src/features/warehouse/labour/labourErrors.ts` (`labourErrorMessage`) — never surface raw RPC/SQLSTATE text in a toast.
- Guards: `supabase/tests/wms_workforce_concurrency_test.sql`, `supabase/tests/wms_lpn_handling_unit_test.sql`.
