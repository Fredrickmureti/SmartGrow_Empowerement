# WMS Product & Inventory Consumer Audit — authoritative status

Question for this wave: does Warehouse act as the **physical execution layer** on
top of the canonical Product and Inventory foundations, or does it re-model them?

## Verified this turn (independent re-derivation, not trusted from notes)

Phases 1, 2.4, 3, 4 and 5 re-checked against the live database:

- `wms_split_putaway_task` and `wms_reassign_putaway_task` both take
  `p_row_version`, take `FOR UPDATE`, raise `wms_task_stale`; the split resolves
  quants by `lpn_id`, not `package_id`.
- `stock_quants` rows whose `package_id` is a license plate: **0**; the guard
  trigger `trg_stock_quants_package_id_is_packaging` exists.
- Count RPCs (`create_count_session_as`, `post_count_session`) no longer touch
  `business_event_outbox` (trigger is the single producer);
  `_wms_count_trigger_from_event` keys off the live `warehouse.replen.completed`.
- `wms_events_catalog` holds 119 rows.

Verdict: Phases 1–5 stand. Resume at Phase 6.

## Phase 6 — handling unit vs product packaging (ACTIVE)

Evidence gathered:

- Separation of *definitions* is sound: `wms_license_plates.packaging_type_id`
  points at `wms_packaging_types` (carton/pallet **materials**: dims, tare,
  max weight, nest ratio) and never at `product_packaging`. No `wms_*` table
  duplicates `qty_in_base_uom`.
- Three real defects on the plate *execution* path:
  1. **Client-authoritative UoM.** `wms_lpn_load` / `wms_lpn_unload` /
     `wms_lpn_split` accept a bare `numeric` quantity with no packaging level, so
     an operator handling 10 bags relies on a human/client conversion. This
     bypasses the Phase 1 seam (`wms_to_base_qty` over `product_packaging`) that
     every other capture RPC uses.
  2. **Concurrency holes.** `wms_lpn_split` has no version argument at all;
     `wms_lpn_move/dispatch/seal/retire/load/unload/merge/nest` accept
     `_expected_version` with a `NULL` default, so a stale client simply omits it.
  3. **Unit truth regression.** `src/pages/warehouse/LicensePlateView.tsx`
     renders raw `Number(c.quantity)` with a hardcoded "units" string and never
     imports `formatQty` — the Phase 2.4 invariant.
- Container capacity (`max_weight_kg`, outer dims, `max_volume_fill_pct`) is
  defined on `wms_packaging_types` but no LPN function reads it, so plates can be
  overloaded past their physical container limits.

Implementation:

1. **Server — packaging-aware plate capture.** `wms_lpn_load`, `wms_lpn_unload`
   and `wms_lpn_split` take `_packaging_id uuid` + entered quantity and convert
   through the existing `wms_to_base_qty`; base quantity is never accepted from
   the client. Old signatures dropped (Phase 3 precedent) so no stale path
   survives.
2. **Server — optimistic locking made mandatory.** Every `wms_lpn_*` mutator
   takes a required `_expected_version`, takes `FOR UPDATE`, raises the shared
   stale error and bumps `row_version`. Unversioned overloads dropped.
3. **Server — container capacity as configuration, not hardcode.** Load/merge/
   nest check the plate's `wms_packaging_types` limits against Product physical
   measurements (weight/volume from the canonical product fields); breach routes
   to `wms_exceptions` with the existing typed resolution, with the enforce/warn
   choice read from warehouse configuration rather than a literal.
4. **Client wiring.** `useLpnOps`, `LicensePlateView` and `MobilePlate` pass the
   selected packaging level and the rendered `row_version`; stale errors surface
   as the existing "Someone else just updated this" copy; every plate quantity
   renders through `@/lib/inventory/formatQty`.
5. **Guards.** Extend `src/test/architecture/lpn-handling-units.test.ts`
   (packaging level threaded, version threaded, formatQty used) and add
   `supabase/tests/wms_lpn_handling_unit_boundary_test.sql` (no `wms_*` column
   duplicates a `product_packaging` attribute; plates reference only
   `wms_packaging_types`; every `wms_lpn_*` mutator is versioned; load/unload/
   split call `wms_to_base_qty`).

## Pending after Phase 6

**Phase 7 — costing and valuation seam.** Landed cost, quarantine and damage
dispositions route to canonical costing functions; no warehouse-local valuation.

Out of scope this wave: Yard (including its exempt `warehouse.yard.*` topics),
Workforce beyond enterprise-identity consumption, 3PL billing.

## Working rules

- Every phase lands as server RPC + caller wiring + guard (pgTAP for server
  invariants, `src/test/architecture/*` for client wiring), then this plan is
  updated in the same turn.
- The wider `src/test/architecture` run has pre-existing, unrelated failures
  (product identifier seam, pdf preview iframe, `pos_hardware_configs`, employee
  lifecycle) — do not attribute those to this wave.
