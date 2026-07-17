# WMS continuation plan

## Verification of prior work (done during this turn)

Read the parent prompt, `.lovable/plan.md`, ADRs 0064/0076/0079, and the shipped code/DB.

Confirmed genuinely done:

- Phases 0–7 all present: tables `wms_license_plates`, `wms_tasks`, `wms_putaway_suggestions`, `wms_pick_waves(+_lines)`, `wms_pack_cartons`, `wms_count_sessions(+_lines)`, `wms_loading_manifests(+_manifest_cartons)`, `warehouse_docks`, `wms_dock_appointments`, `wms_qc_inspections(+_checks, +_hold_reasons)`.
- All eight architecture guards on disk: `wms-phase1..7.test.ts`.
- Warehouse UI pages exist for LPN, tasks, putaway, waves, picking, packing, cycle counts, loading/dispatch, dock schedule, QC queue+detail.
- ADR 0079 Inventory↔Warehouse split honored; `wms_*` tables are RPC-only writes.

Confirmed **gap** (matches plan.md's own "known gaps"):

- Phase 7 QC is a **logical-only** state machine. Inspecting the latest migration
  (`20260717214600_…qc_inspections.sql`) shows `open_qc_inspection`, `accept_qc_inspection`,
  and `reject_qc_inspection` do NOT write any `stock_movements` rows and there is no
  `qc_hold` sub-location provisioning. On-hand quants are untouched by QC → downstream
  replenishment/slotting cannot trust them. This is the blocker plan.md flagged.
- No Phase 8 (replenishment/slotting) artifacts exist yet.

Nothing else is in-flight (no half-written migrations, no orphan pages).

## Execution

### Step 1 — Phase 7.1: QC physical stock effects (blocks Phase 8)

Migration `wms_phase7_1_qc_physical_stock`:

1. Provision one `qc_hold` sub-location per warehouse: a `stock_locations` row with
   `structure_level='sub_zone'`, `location_type='qc_hold'`, parented under the
   warehouse's root location. Backfill for all existing warehouses; idempotent upsert.
2. Helper `_wms_ensure_qc_hold(warehouse_id) → uuid` — on-demand fallback used by RPCs.
3. Rewrite `open_qc_inspection` to, in the same transaction as the insert, post a
   `stock_movements` row moving `sample_size` (or full received qty when
   `sample_strategy='full'`) from the source receiving bin → `qc_hold`. Movement
   type `qc_hold_in`, links back via `source_doc_type='wms_qc_inspection'`,
   `source_doc_id=inspection.id`. Respects lot/serial when present.
4. Rewrite `accept_qc_inspection`: post `qc_hold` → default putaway staging move
   for `accepted_qty` (`movement_type='qc_release'`).
5. Rewrite `reject_qc_inspection` per disposition:
   - `scrap` → `movement_type='qc_scrap'` (outbound from `qc_hold`, reason coded).
   - `return_to_vendor` → same `qc_scrap`-style outbound from `qc_hold` AND seed a
     `purchase_returns` draft row (state `draft`) referencing the source GRN /
     vendor and the rejected qty. RPC returns the draft id.
   - `rework` / `use_as_is` → release back to putaway staging (same as accept).
6. Add trigger / wire-in so GRN post auto-calls `open_qc_inspection` when
   `warehouses.require_qc_on_receipt = true`. Same hook on sales-return receipt
   for lines flagged `requires_inspection`.
7. Every new movement carries the same idempotency key shape and emits
   `stock.movement.*` via the existing outbox trigger (ADR 0076) — no new event
   type needed on the warehouse side.

Guard extension `wms-phase7.test.ts` (or a new `wms-phase7_1.test.ts`):

- Static: no client-side inserts to `stock_movements` under `src/pages/warehouse/qc*`
  (writes must come from the RPCs).
- Contract test via `supabase--read_query`: after `accept_qc_inspection`, at least
  one `stock_movements` row exists with `source_doc_id = inspection.id` and
  `movement_type IN ('qc_release','qc_scrap')`; after `reject … return_to_vendor`,
  a `purchase_returns` draft is present.
- Assert every warehouse has exactly one `qc_hold` `stock_locations` row.

UI touch-ups (small):

- QC detail page shows the physical hold location + resulting movement ids after
  each transition (already fetches inspection; add a movements sub-list).
- GRN wizard: when destination warehouse has `require_qc_on_receipt=true`, show a
  read-only "QC will be opened on post" note and, after post, deep-link to the
  auto-created inspection.

### Step 2 — Phase 8: Replenishment & slotting

Only after 7.1 is green.

Migration `wms_phase8_replenishment`:

- `wms_replenishment_rules(id, scope, product_id, pick_face_location_id, reserve_zone_id, min_qty, max_qty, strategy in ('min_max','demand','wave_driven'), enabled, is_sample_data)`.
- `wms_replenishment_tasks` — thin projection over `wms_tasks` with `task_type='replenishment'` plus `source_location_id`, `destination_location_id`, `product_id`, `qty`, `rule_id`.
- Slotting analytics view `wms_slotting_velocity_v` — 30/90-day pick velocity per
  product × pick-face bin, ABC-classified, joined to bin capacity.

RPCs (all `SECURITY DEFINER`, `SET LOCAL search_path=public`, outbox-wrapped):

- `generate_replenishment_tasks(p_warehouse_id, p_strategy)` — evaluates active
  rules, enqueues `wms_tasks` rows; emits `warehouse.replenishment.generated`.
- `complete_replenishment_task(p_task_id, p_moved_qty)` — writes one
  `stock_movements` row reserve → pick face, marks task done; emits
  `warehouse.replenishment.completed`.
- `upsert_replenishment_rule(...)` / `disable_replenishment_rule(...)`.

Events registered in `domainEventBus.ts` + `BusinessSagaMount.tsx` (log-only).

UI:

- `/warehouse-app/replenishment` — rules table, "Generate tasks" action, live task
  queue with executor.
- `/warehouse-app/slotting` — read-only ABC × pick-face suitability table.
- Nav entry under Operations.

Guard `wms-phase8.test.ts`: RPC-only writes to `wms_replenishment_*`, events wired,
RPC signatures present in `types.ts`.

### Step 3 — House-keeping

- Update `.lovable/plan.md`: move Phase 7.1 and Phase 8 to **Done**, seed **Next**
  with Phase 9 (yard/trailer) per the chronological order rule.
- Run `bunx vitest run src/test/architecture/wms-phase*.test.ts` and `bunx tsgo --noEmit`.

## Explicitly out of scope this pass

- Yard/trailer management (Phase 9), labour management (Phase 10), 3PL billing (Phase 11).
- AQL sampling auto-computation, vendor-portal RTV, predictive QC.
- Any change to Inventory-owned tables beyond adding `stock_movements` rows via
  sanctioned movement types. No cost-layer or AVCO logic changes.

## Non-negotiables carried forward

1. Inventory is the single source of truth for quantity/value. Warehouse only
   emits movements through the existing ledger.
2. `wms_*` tables stay RPC-only writes; every state transition emits an outbox
   event; every phase ships an architecture guard.
3. Chronological order: 7.1 → 8 → 9 → 10 → 11. Do not skip.
