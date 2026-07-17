## Verification of the previous engineer's handoff

Independently checked plan.md against the codebase and the live database:

- Phase 0 (scaffolding + `stock_locations` extensions): confirmed. Columns `structure_level`, `barcode`, `pick_sequence`, `capacity_max_*` present.
- Phase 1 (`wms_license_plates`, `wms_tasks`, `move_lpn`, outbox triggers): confirmed. Tables, triggers, and RPC exist in DB. `LicensePlates`, `LicensePlateView`, `OperatorTasks` pages present.
- Phase 2 (receiving → putaway):
  - `stock_locations.putaway_priority / is_receiving_staging / is_putaway_target` — present.
  - `wms_tasks.metadata jsonb` — present.
  - `wms_putaway_suggestions` table — present.
  - RPCs `suggest_putaway_locations`, `receive_goods_to_wms`, `complete_putaway_task` — present in `pg_proc`.
  - Pages `PutawayQueue.tsx`, `ReceiveToWMSDialog.tsx` — present and wired into `apps/warehouse/routes.tsx` + `nav.ts`.
  - Guards `wms-phase1.test.ts` + `wms-phase2.test.ts` — present.
- Phase 3 (Picking) — not started. No `wms_pick_waves` table, no pick/pack RPCs, no Wave/Pick/Pack UI.

Two Phase-2 debts were explicitly deferred by the previous engineer and are still open:
1. Suggestions panel on `LicensePlateView` (data ready in `wms_putaway_suggestions`).
2. No saga/log handlers registered for `warehouse.*` events (outbox already writes them).

Verdict: handoff is truthful. Resume at Phase 3, and close the two small debts as a prelude so the outbound loop starts on a clean substrate.

## What I will build

### 0. Close Phase 2 debts (small, ~1 file each)
- `LicensePlateView.tsx`: when the plate sits at a staging bin, render its top-3 rows from `wms_putaway_suggestions` with a "re-suggest / pick different bin" affordance that updates the task's `destination_location_id` (still goes through `move_lpn` on completion).
- Register no-op log handlers for `warehouse.receipt.staged`, `warehouse.putaway.suggested`, `warehouse.putaway.completed`, `warehouse.plate.moved`, `warehouse.task.*` in `BusinessSagaMount` so the outbox pipe has a real subscriber and the architecture guard added in Phase 2 stays honest.

### 1. Phase 3 — Picking (Sales Order → Wave → Pick → Pack)

Migration `wms_phase3_picking`:
- `wms_pick_waves(id, business_id, warehouse_id, code, state, released_at, released_by, created_at/by, updated_at)` with state enum `draft | released | picking | picked | packed | closed | cancelled`. Grants + RLS scoped by business.
- `wms_pick_wave_lines(id, wave_id, sales_order_id, sales_order_item_id, product_id, lot_number, quantity_requested, quantity_picked, source_location_id, state)`.
- Extend `wms_tasks.task_type` to include `pick`, `pack`, `stage_out` (enum permits — will guard).
- New RPC `create_pick_wave(p_warehouse_id, p_sales_order_ids uuid[])` — bundles SO lines into a draft wave.
- New RPC `release_pick_wave(p_wave_id)` — atomically:
  1. Reserves stock in `stock_reservations` per SO line (FEFO where lot-tracked, else quant-priority by `pick_sequence`).
  2. Splits per source bin into `wms_tasks(task_type='pick', ...)` ordered by `pick_sequence`.
  3. Transitions wave `draft → released`.
- New RPC `complete_pick_task(p_task_id, p_picked_qty, p_lpn_id?)` —
  1. Decrements `stock_quants` at source bin (and matching reservation), 
  2. Assigns/creates a pick-cart LPN and stamps `wms_pick_wave_lines.quantity_picked`,
  3. Transitions task to `done`,
  4. When all wave lines are picked, flips wave to `picked` and creates one `pack` task per SO.
- New RPC `complete_pack_task(p_task_id, p_shipment_lpn_id, p_weight_kg?, p_dims?)` — closes the pack task, links the shipping LPN to the SO, wave transitions when all packs done.

### 2. UI
- `src/pages/warehouse/WavePlanner.tsx` — pick warehouse, multi-select unfulfilled SOs, "Create wave" → "Release".
- `src/pages/warehouse/PickList.tsx` — mobile-first task cards ordered by `pick_sequence`; scan bin/product placeholder (real scanner comes Phase 4); confirm qty → `complete_pick_task`.
- `src/pages/warehouse/PackStation.tsx` — one card per pack task; enter shipping LPN + weight/dims → `complete_pack_task`.
- Nav: add `Operations → Waves`, `Picking`, `Packing` under existing Warehouse nav.

### 3. Events
Add to `DomainEventType` and `BusinessSagaMount`:
`warehouse.wave.created`, `warehouse.wave.released`, `warehouse.pick.completed`, `warehouse.wave.picked`, `warehouse.pack.completed`, `warehouse.wave.closed`.

### 4. Architecture guards `src/test/architecture/wms-phase3.test.ts`
- No client code inserts `wms_tasks` with `task_type in ('pick','pack','stage_out')` directly — must go through RPCs.
- No client code UPDATEs `wms_pick_waves.state` directly.
- Completing pick/pack tasks routes through the corresponding RPC (no bare `state:'done'` update).
- Every new `warehouse.*` event has a handler in `BusinessSagaMount`.

### 5. Boundary discipline (non-negotiable)
- Inventory remains canonical: pick RPCs write to `stock_quants` / `stock_reservations` only, never duplicate them into a WMS-owned quant table.
- Every wave / pick / pack RPC uses `SET LOCAL search_path = public`, wraps in a single transaction, and emits its outbox row via the existing pattern from Phases 1–2 (RAISE WARNING on outbox failure, never fail the physical action).

## Success criteria (one-shot verification)
1. Create a wave from 2 real sales orders → `release_pick_wave` produces N pick tasks (grouped by source bin), reservations exist in `stock_reservations`.
2. Completing every pick task flips wave to `picked` and creates one pack task per SO.
3. Completing pack tasks closes the wave and emits `warehouse.wave.closed` in `business_event_outbox`.
4. `bunx vitest run src/test/architecture/wms-phase1.test.ts src/test/architecture/wms-phase2.test.ts src/test/architecture/wms-phase3.test.ts` — all green.
5. `bunx tsgo --noEmit` clean.

## Explicitly out of scope (deferred to later phases)
- Scanner-driven directed picking (Phase 4).
- Cycle counting wiring (Phase 4).
- Putaway rule engine + constraints (Phase 5).
- Dock scheduling / appointments (Phase 6).
- Carrier rate shopping, manifests, load planning (Phase 7).

## Files touched
**New:** `supabase/migrations/<ts>_wms_phase3_picking.sql`, `src/pages/warehouse/{WavePlanner,PickList,PackStation}.tsx`, `src/test/architecture/wms-phase3.test.ts`, `docs/adr/0081-picking-substrate.md`.

**Modified:** `src/pages/warehouse/LicensePlateView.tsx` (suggestions panel), `src/apps/warehouse/{nav.ts,routes.tsx}`, `src/services/events/domainEventBus.ts`, `src/contexts/BusinessSagaMount.tsx`, plan.md handoff log.

---

## Handoff — Phase 3 complete (2026-07-17)

Delivered:
- Migration `wms_phase3_picking`: `wms_pick_waves` + `wms_pick_wave_lines` (RLS + grants), RPCs `create_pick_wave`, `release_pick_wave`, `complete_pick_task`, `complete_pack_task`. Also fixed Phase 2 outbox inserts (`organization_id` → `org_id`, dropped bogus `business_id`) so `warehouse.receipt.staged` / `warehouse.putaway.completed` land.
- UI: `WavePlanner.tsx`, `PickList.tsx`, `PackStation.tsx` + nav + routes.
- Phase 2 debts closed: `LicensePlateView` shows ranked putaway suggestions; `BusinessSagaMount` registers log-only handlers for every `warehouse.*` event.
- Guardrail: `src/test/architecture/wms-phase3.test.ts` — no direct `wms_tasks` insert with `task_type in ('pick','pack')`, no bare wave-state UPDATE, screens must call the sanctioned RPCs. Phase 1 + 2 + 3 arch tests + full tsgo pass.

Deviations from plan:
- Wave `state` enum shipped as `draft|released|picking|picked|packing|packed|cancelled` (added `packing`, dropped `closed` — `packed` is terminal for MVP). No `stage_out` task type yet.
- `complete_pack_task` mints an optional shipment LPN keyed by the whole wave rather than one pack task per SO. Per-SO pack tasks deferred to Phase 4 alongside multi-carton packing.
- `warehouse.wave.created` / `warehouse.wave.picked` / `warehouse.wave.closed` events not emitted; only `warehouse.wave.released`, `warehouse.pick.completed`, `warehouse.pack.completed` are wired. Fine-grained lifecycle events can be added when a saga needs them.

Open for Phase 4: scanner-driven directed picking (bin + product scan → resolve task), multi-carton pack, cycle-count wiring against `stock_quants`.

