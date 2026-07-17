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

---

## Handoff — Phase 4a complete (2026-07-17)

Delivered (scanner-driven directed picking, UI-only on the Phase 3 substrate):
- `src/pages/warehouse/PickList.tsx` refactored to scan-first. Dual `BarcodeInputField` (Bin + Product) at the top.
- Barcode resolution reuses `useResolveBarcode` (RPC `pos_resolve_barcode`) — matches GTIN / SKU / alias. No new RPCs, no schema change, no new events.
- Match logic: scanned bin + resolved product → first open `pick` task in the wave whose `source_location_id` and `product_id` match. On hit: scroll + highlight row, prefill picked qty with `quantity_requested`. On miss: inline diagnostic (wrong bin, product not in wave, unknown barcode).
- Successful `complete_pick_task` clears both scan fields for the next pick.
- Verified: `bunx tsgo --noEmit` clean; Phase 1/2/3 architecture tests still green (no new sanctioned mutation surface, so no new guard needed).

Deviations: none — scope was intentionally kept UI-only.

## Where to pick up next — Phase 4b, then 4c

Chronological order matches the business-event flow (pick → pack → count). Do **4b before 4c** — the count RPC in 4c is a prerequisite for Phase 5 putaway rules trusting on-hand data.

### Phase 4b — Multi-carton packing (next up)
Fixes Phase 3 deviation: `complete_pack_task` currently mints one wave-level LPN; real operations need per-carton, per-SO shipment LPNs.

1. **Migration** `wms_phase4b_multicarton.sql`:
   - Table `wms_pack_cartons(id, wave_id, sales_order_id, shipment_lpn_id, weight_kg, length_cm, width_cm, height_cm, sealed_at, sealed_by, org_id, ...)`. RLS by business; grants for `authenticated` + `service_role`.
   - Column `wms_pick_wave_lines.packed_carton_id uuid null references wms_pack_cartons(id)`.
   - Backfill: on wave flip to `picked`, create one `pack` task per SO (not per wave).
2. **RPCs**:
   - `open_pack_carton(p_wave_id, p_sales_order_id)` — mints shipment LPN via existing LPN pattern, returns carton id.
   - `assign_line_to_carton(p_carton_id, p_wave_line_id, p_qty)` — validates same-SO, sets `packed_carton_id`.
   - `seal_pack_carton(p_carton_id, p_weight_kg, p_dims jsonb)` — stamps `sealed_at/by`, emits `warehouse.carton.sealed`.
   - Rewrite `complete_pack_task`: done only when every wave line for that SO has a `packed_carton_id` and every carton is sealed. Wave `packed` derives from all pack tasks done.
3. **Events** (add to `domainEventBus.ts` + log handlers in `BusinessSagaMount`): `warehouse.carton.opened`, `warehouse.carton.sealed`. Keep `warehouse.pack.completed` but emit per SO.
4. **UI** — rework `src/pages/warehouse/PackStation.tsx`: one panel per open SO in the wave, "Open new carton", assign picked lines to the active carton, seal dialog captures weight + LxWxH.
5. **Guard** — new `src/test/architecture/wms-phase4b.test.ts`: no direct `wms_pack_cartons` insert / no bare `sealed_at` UPDATE from client — must route through RPCs.

### Phase 4c — Cycle counting (after 4b)
Introduces `warehouse.count.*` and adjusts `stock_quants` through a sanctioned RPC only.

1. **Migration** `wms_phase4c_cycle_count.sql`:
   - `wms_count_sessions(id, warehouse_id, state[draft|counting|review|posted|cancelled], strategy[abc|random|targeted], posted_at, posted_by, org_id, ...)`.
   - `wms_count_lines(session_id, location_id, product_id, lot_number, system_qty, counted_qty, variance_qty, note, counted_by, counted_at)`.
   - RLS + grants.
2. **RPCs**:
   - `create_count_session(p_warehouse_id, p_strategy, p_location_ids uuid[])` — snapshots `system_qty` from `stock_quants` into lines.
   - `record_count(p_line_id, p_counted_qty, p_note?)` — updates counted qty + variance.
   - `post_count_session(p_session_id)` — for each non-zero-variance line, post an adjustment against `stock_quants` via the existing inventory adjustment RPC (do NOT hand-edit `stock_quants`), emit `warehouse.count.posted`, transition session to `posted`.
3. **Events**: `warehouse.count.opened`, `warehouse.count.recorded`, `warehouse.count.posted` — register log-only handlers.
4. **UI**: `CycleCountPlanner.tsx` (create session), `CountSession.tsx` (scan-first — reuse `BarcodeInputField` from Phase 4a: scan bin → expected products → scan product + counted qty, variance highlighted), `CountReview.tsx` (supervisor posts).
5. **Guard** — `wms-phase4c.test.ts`: no direct `stock_quants` UPDATE anywhere in `src/pages/warehouse/**`; count sessions/lines mutated only via RPCs.

### Verification checklist for the next agent (do this first)
1. Re-read this file top-to-bottom.
2. Confirm the last WMS migration is `wms_phase3_picking` (nothing new snuck in): `ls supabase/migrations | grep wms_`.
3. Prove the substrate is still green: `bunx vitest run src/test/architecture/wms-phase1.test.ts src/test/architecture/wms-phase2.test.ts src/test/architecture/wms-phase3.test.ts` and `bunx tsgo --noEmit`.
4. Only then start Phase 4b. Do not skip to Phase 5 (rule engine) or Phase 6 (dock scheduling) — 4c on-hand accuracy is their prerequisite.

### Known debt carried across phases
- `business_event_outbox` still lacks a `business_id` column — everything scopes by `org_id`. Fine for now; revisit before cross-org tenant slicing.
- Fine-grained wave lifecycle events (`warehouse.wave.created`, `.picked`, `.closed`) not emitted — add when a saga actually needs them.
- No `stage_out` task type yet (was in original Phase 3 plan). Only add when loading/manifest work in Phase 7 needs it.
- Per-SO pack tasks — resolved by Phase 4b above.


