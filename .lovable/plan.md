# WMS Product & Inventory Consumer Audit — live status

## Verified (server side)
- `wms_to_base_qty` is the single conversion authority; `wms_capture_receiving_line`,
  `record_count`, return capture all take `(entered_qty, packaging_id)` and derive base.
- Warehouse client writes never touch `stock_quants` / `stock_movements` — all go
  through FSM/domain RPCs.
- Guard suite `src/test/architecture/wms-server-authoritative-uom.test.ts` — 8/8 green.

## Phase 2.4 — unit truth on every warehouse quantity render (in progress)

Canonical helpers (new):
- `src/features/warehouse/quantity/warehouseQty.tsx` — `useWarehouseQtyFormatter`,
  `WarehouseQty`, `AggregateQty`; delegates to `@/lib/inventory/formatQty`.
- `src/features/warehouse/quantity/useProductBaseUomLabels.ts` — batched
  `products.base_uom_id → units_of_measure.code` via `baseUomLabel()`.

Migrated:
- Receiving session workspace (expected / received / variance / capture preview;
  mixed-UoM quantity totals replaced with line counts).
- Count review (expected / counted / difference).
- Count session (system / variance / base preview).
- Return lines panel (received / expected / disposition split label).
- Pick list (requested + completed), Putaway queue (task qty).

Remaining surfaces:
- PackStation, CrossdockBoard, CycleCounts, OperatorTasks, TaskHistorySheet,
  BillingBoard, PackagingDetailPanels.
- Add an architecture guard that fails on naked `Number(x.quantity).toFixed()`
  renders inside `src/pages/warehouse` and `src/features/warehouse`.
