# WMS Product & Inventory Consumer Audit — live status

## Currently active phase
**Phase 2.4 — unit truth on every warehouse quantity render: COMPLETE.**
Next milestone: **Phase 3 — task/FSM lifecycle completeness audit** (see below).

## Fully implemented and verified

### Phase 1 — server-authoritative UoM conversion (verified)
- `wms_to_base_qty` is the single conversion authority; `wms_capture_receiving_line`,
  `record_count` and return capture all take `(entered_qty, packaging_id)` and derive base.
- Warehouse client writes never touch `stock_quants` / `stock_movements` — all go through
  FSM/domain RPCs.
- Guard: `src/test/architecture/wms-server-authoritative-uom.test.ts` — 8/8 green.

### Phase 2.4 — unit truth on renders (verified)
Canonical seam:
- `src/features/warehouse/quantity/warehouseQty.tsx` — `useWarehouseQtyFormatter`,
  `WarehouseQty`, `AggregateQty`; delegates to `@/lib/inventory/formatQty` (no local maths).
- `src/features/warehouse/quantity/useProductBaseUomLabels.ts` — batched
  `products.base_uom_id → units_of_measure.code` via `baseUomLabel()`.

Migrated surfaces (all render pack rollup + base unit, never a naked integer):
- Receiving session workspace (expected / received / variance / capture preview; mixed-UoM
  totals replaced with line counts).
- Count review, Count session (system / counted / variance / base preview).
- Return lines panel (received / expected / disposition split).
- Pick list (requested + completed), Putaway queue (task qty).
- Pack station (picked + packed), Operator tasks, Task history sheet (qty + qty change).
- Billing board (tariff `uom` appended — priced in the tariff unit, exempted from the guard).
- Handling unit preview (labelled "Base units" + SKU count, an explicit cross-product aggregate).
- Cycle counts activity ledger — required a migration: `get_count_command_center` now returns
  `product_id` per activity row so variances format with the product's own unit.
- Packaging availability panel — on hand / reorder point labelled in pieces (packaging stock,
  not product base UoM).

Guards: `src/test/architecture/warehouse-qty-display.test.ts` (3/3) fails on any
`Number(x.quantity).toFixed()` under `src/pages/warehouse` or `src/features/warehouse`, and
pins the seam as delegation-only. Typecheck (`tsgo -p tsconfig.app.json`) clean.

## Pending work (roadmap order)

### Phase 3 — task/FSM lifecycle completeness (next)
1. Enumerate every `wms_*` task RPC and confirm each transition is guarded by state +
   `row_version` (optimistic concurrency), with no client-side state derivation.
2. Verify claim/release/complete paths cannot orphan a task (crash mid-flow, offline replay).
3. Add an architecture guard that fails on client code writing task `state`/`status` directly
   instead of calling a transition RPC.

### Phase 4 — inventory boundary enforcement
- Prove every warehouse mutation lands in Inventory through domain RPCs, and add a guard for
  direct `stock_quants` / `stock_movements` / `cost_layers` writes from `src/pages/warehouse`
  and `src/features/warehouse`.

### Phase 5 — event-driven integration
- Confirm each lifecycle transition emits to `business_event_outbox` with an idempotency key,
  and that no consumer relies on client-emitted events.

## Instructions for the next agent
1. **Verify before extending.** Run `bunx vitest run src/test/architecture` and
   `bunx tsgo --noEmit -p tsconfig.app.json`; both must be green. Then spot-check three
   Phase 2.4 surfaces (Cycle counts, Pack station, Task history sheet) for: batched hook usage
   (one query per surface, not per row), no hardcoded unit words in JSX, and no local
   `qty_in_base_uom` arithmetic.
2. **Do not start unrelated work.** Resume at Phase 3 step 1 above.
3. Bring each phase to a production-ready state (RPC + client + guard test + plan update)
   before moving on; update this file immediately after each implementation.
