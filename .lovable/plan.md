# WMS continuation plan — chronological handoff log

> Purpose: single source of truth for the next agent. Read this top-to-bottom
> before touching code. Chronological order is **non-negotiable** — do not skip
> phases, do not reorder. Each phase ships: migration(s) + RPC(s) + UI +
> architecture guard test + ADR/plan entry.

---

## 1. Non-negotiables (carry forward every phase)

1. **Inventory owns quantity & value.** Warehouse only posts through
   `stock_movements` (two-row signed transfer convention). WMS never mutates
   `stock_quants` directly, never writes cost.
2. **`wms_*` tables are RPC-only** for state transitions. The only sanctioned
   PostgREST writes are user-authored **master data** (currently:
   `wms_replenishment_rules`), always business-scoped RLS.
3. **Every state transition emits** a `warehouse.*` (or `stock.movement.*`)
   business event onto `business_event_outbox` with idempotency key
   `wms.<entity>:<id>:<state>`.
4. **Every phase ships an architecture guard** under
   `src/test/architecture/wms-phaseN.test.ts`.
5. **Chronological order:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 7.1 → 8 → **9** →
   10 → 11 → 12. Do not skip.
6. **UI rule:** only wire nav entries for pages that are BUILT and functional.
7. Reference ADRs: **0064** (locations/quants), **0068** (transfers), **0076**
   (stock event fabric), **0078** (AVCO), **0079** (Inventory vs Warehouse
   split — the charter for this whole track).

---

## 2. What is shipped (chronological)

### Phase 0 — Scaffolding & layout editor  ✅
Warehouse workspace mounted at `/warehouse-app/*`. `stock_locations` extended
with `structure_level`, `barcode`, `pick_sequence`, capacity fields. Layout
editor (zones → aisles → racks → bins).

### Phase 1 — LPN + universal task substrate  ✅
`wms_license_plates`, `wms_tasks` (polymorphic task_type). RPCs:
`create_lpn`, `move_lpn`, `assign_task`, `start_task`, `complete_task`.

### Phase 2 — Receiving  ✅
`wms_receiving_appointments` → GRN → LPN creation on dock.

### Phase 3 — Put-away  ✅
Directed put-away tasks. `complete_putaway_task` moves LPN from dock →
destination bin, posts `stock_movements`.

### Phase 4 — Picking & waves  ✅
`wms_pick_waves`, wave planner UI, pick tasks generated from sales orders /
transfer orders. Pick confirmation posts source-bin → staging movement.

### Phase 5 — Packing & dispatch  ✅
`wms_pack_stations`, `shipment_packages`, `loading_manifests`. Dispatch posts
staging → outbound movement + emits `warehouse.shipment.dispatched`.

### Phase 6 — Cycle counting  ✅
`wms_cycle_counts`. Variance posts adjustment movement.

### Phase 7 — QC (logical state machine)  ✅
`wms_qc_inspections` with `open/accept/reject` state transitions.
**Gap identified during audit:** no physical stock effect → fixed in 7.1.

### Phase 7.1 — QC physical stock effects  ✅
- `QUARANTINE` + `STOCK` locations backfilled per warehouse.
- Helpers `_wms_ensure_qc_hold`, `_wms_default_putaway`,
  `_wms_qc_post_move` (two-row signed movements).
- `open_qc_inspection` moves qty STOCK → QUARANTINE.
- `accept_qc_inspection` releases QUARANTINE → STOCK.
- `reject_qc_inspection` handles dispositions: `scrap`,
  `return_to_vendor` (seeds `purchase_returns` draft), `rework`,
  `use_as_is`.
- `emit_qc_event` fixed to correct `business_event_outbox` schema
  (`org_id`, `source_doc_type`, ...).
- `products.requires_qc` added; trigger `trg_wms_auto_open_qc_on_grn`
  auto-opens QC on GRN completion.

### Phase 8 — Replenishment & slotting  ✅
- Table `wms_replenishment_rules` (biz-scoped, RLS, master data).
- RPC `generate_replenishment_tasks(warehouse)` — evaluates active rules,
  enqueues `wms_tasks(task_type='replenish')` from source → pick face,
  respects `pack_multiple`, dedupes open tasks.
- View `wms_slotting_velocity_view` — rolling 90-day pick velocity per
  product per warehouse, A/B/C via `PERCENT_RANK`.
- UI: `/warehouse-app/replenishment` (rules CRUD + "Generate tasks" +
  live open-task queue + activate toggle) and `/warehouse-app/slotting`
  (A/B/C dashboard, filters, ranked table).
- Nav entries under Operations.
- Guard `src/test/architecture/wms-phase8.test.ts` — blocks direct
  `wms_tasks` inserts of `task_type='replenish'`, blocks writes to the
  velocity view, asserts RPC + route + nav wiring.

---

## 3. What is NOT yet implemented (in order)

### ▶ Phase 9 — Yard & Trailer Management  **← START HERE NEXT**

Goal: turn dock appointments from a calendar into a live yard-ops signal.
Without this, dwell / on-time / detention KPIs cannot be computed and
security (seal capture) has no home.

**Backend (migration 1):**

- `wms_yard_slots(id, business_id, warehouse_id, code, slot_type
  {inbound|outbound|either|hazmat|reefer}, status
  {available|occupied|blocked}, notes)`
  - RLS: biz-scoped. Master data → PostgREST writes allowed for
    warehouse admins.
  - GRANT SELECT/INSERT/UPDATE/DELETE to authenticated per policy;
    GRANT ALL to service_role.
- `wms_trailer_visits(id, business_id, warehouse_id, carrier_id,
  trailer_ref, driver_name, driver_phone, seal_in, seal_out,
  yard_slot_id, dock_id, appointment_id, arrived_at, docked_at,
  departed_at, status {arrived|in_yard|at_dock|departed|no_show})`
  - RPC-only writes.

**Backend (migration 2 — RPCs, all `SECURITY DEFINER`, all emit events):**

- `check_in_trailer(warehouse_id, carrier_id, trailer_ref, driver_name,
  driver_phone, seal_in, appointment_id?)` → creates visit, sets
  status `arrived`, auto-parks into first available yard slot if any,
  emits `warehouse.yard.checked_in`.
- `assign_trailer_to_dock(visit_id, dock_id)` → validates dock is free,
  updates visit + dock, frees yard slot, sets `docked_at`, emits
  `warehouse.yard.docked`. If `appointment_id` present, links + updates
  appointment status.
- `depart_trailer(visit_id, seal_out)` → sets `departed_at`, releases
  dock, closes visit, emits `warehouse.yard.departed`. Computes dwell
  server-side.

**Frontend:**

- `/warehouse-app/yard` page — two-pane layout:
  - Left: **Arrivals board** (visits, filters by status, actions:
    check-in dialog, assign-to-dock, depart).
  - Right: **Yard map** (slot grid, colour by status, click to view
    occupying visit).
- Nav entry under Operations: "Yard".

**Guard `wms-phase9.test.ts`:**

- No client-side inserts to `wms_trailer_visits`.
- Yard page calls the three RPCs.
- Route + nav wired.
- `wms_yard_slots` writes allowed only from the Yard master-data page.

**Definition of done for Phase 9:**

- [ ] Migrations applied, Supabase types regenerated.
- [ ] Three RPCs unit-callable and emit events into
      `business_event_outbox` with correct idempotency keys
      (`wms.trailer_visit:<id>:<state>`).
- [ ] Yard page renders, all three flows work end-to-end.
- [ ] Guard test green.
- [ ] Plan file updated: move Phase 9 to §2, set Phase 10 as next.
- [ ] New ADR `0080-wms-yard-management.md` capturing the appointment
      ↔ visit ↔ dock linkage.

### Phase 10 — Labour management

- `wms_task_standards(task_type, uom, seconds_per_uom)` — engineered
  labour standards.
- Extend `wms_tasks` with `earned_seconds`, `actual_seconds` (already
  have `started_at`, `completed_at` — compute on complete).
- View `wms_operator_productivity_view` — earned/actual per operator
  per shift, utilisation %.
- UI: `/warehouse-app/labour` — supervisor dashboard, standards CRUD,
  operator leaderboard.
- Guard `wms-phase10.test.ts`.

### Phase 11 — 3PL activity-based billing

- `wms_billing_tariffs(client_id, activity, uom, rate, effective_from,
  effective_to)`.
- Consumer subscribes to `warehouse.*` events from
  `business_event_outbox` → writes `wms_billable_activities`.
- Month-end RPC `generate_3pl_invoice(client_id, period)` → creates
  draft invoice in Sales.
- UI: `/warehouse-app/billing` — tariffs, activity ledger, invoice
  preview.
- Guard `wms-phase11.test.ts`.

### Phase 12 — Cross-dock & cartonization (deferred)

Only after 9–11 land. Cross-dock uses inbound-to-outbound task chaining;
cartonization needs product dims + carton catalogue (new master data).

---

## 4. Explicitly out of scope this track

- AQL sampling automation, vendor-portal RTV, predictive QC.
- Cost-layer / AVCO changes (owned by Inventory, ADR 0078).
- Voice-pick / RF-gun hardware integration (post Phase 12).
- WCS/WES integration for automated MHE (separate track).

---

## 5. Handoff — exact starting point for next agent

**File to open first:** this plan.
**Second:** `docs/adr/0079-inventory-vs-warehouse-split.md` (charter).
**Third:** `supabase/migrations/20260717221821_*_replenishment_slotting.sql`
(most recent shipped pattern — mirror its structure for Phase 9).

**First commands to run (parallel):**

1. `code--view src/pages/warehouse/Replenishment.tsx` — copy this page's
   shape (RPC call + live query + create dialog) for the Yard page.
2. `code--view supabase/migrations/20260717214600_*_qc_inspections.sql` —
   copy the `emit_business_event` + idempotency-key pattern for the
   yard RPCs.
3. `rg "wms_dock_appointments" supabase/migrations` — Phase 9 must link
   `wms_trailer_visits.appointment_id` correctly.

**First edit:** new migration
`supabase/migrations/<ts>_wms_phase9_yard_trailers.sql` per §3 Phase 9
spec. Then RPCs migration. Then Supabase types regen. Then Yard page.
Then guard test. Then update this plan (move Phase 9 to §2, promote
Phase 10 to "start here next").

**Do not** start Phase 10 work until Phase 9 DoD checklist is 100% green.
