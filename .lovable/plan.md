# WMS continuation plan — chronological handoff log

> Purpose: single source of truth for the next agent. Read this top-to-bottom
> before touching code. Chronological order is **non-negotiable** — do not
> skip phases, do not reorder. Each phase ships: migration(s) + RPC(s) + UI +
> architecture guard test + ADR/plan entry.

---

## 1. Non-negotiables (carry forward every phase)

1. **Inventory owns quantity & value.** Warehouse only posts through
   `stock_movements` (two-row signed transfer convention). WMS never mutates
   `stock_quants` directly, never writes cost.
2. **`wms_*` operational tables are RPC-only** for state transitions. The
   sanctioned PostgREST writes are user-authored **master data** only
   (currently: `wms_replenishment_rules`, `wms_yard_slots`).
3. **Every state transition emits** a `warehouse.*` (or `stock.movement.*`)
   business event onto `business_event_outbox` with idempotency key
   `wms.<entity>:<id>:<state>`.
4. **Every phase ships an architecture guard** under
   `src/test/architecture/wms-phaseN.test.ts`.
5. **Chronological order:** 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 7.1 → 8 → 9 →
   10 → **11** → 12 → 13 → 14 → 15 → 16. Do not skip.
6. **UI rule:** only wire nav entries for pages that are BUILT and functional.
7. Reference ADRs: **0064** (locations/quants), **0068** (transfers), **0076**
   (stock event fabric), **0078** (AVCO), **0079** (Inventory vs Warehouse
   split — the charter for this whole track), **0080** (yard management),
   **0081** (labour management), **0082** (3PL activity billing).

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

### Phase 7.1 — QC physical stock effects  ✅
QUARANTINE/STOCK backfill, helpers `_wms_ensure_qc_hold`,
`_wms_default_putaway`, `_wms_qc_post_move`. RPCs move stock between
STOCK and QUARANTINE and handle `scrap` / `return_to_vendor` (seeds
`purchase_returns`) / `rework` / `use_as_is`. `products.requires_qc` +
`trg_wms_auto_open_qc_on_grn` auto-open QC on GRN completion.

### Phase 8 — Replenishment & slotting  ✅
- `wms_replenishment_rules` (biz-scoped master data).
- RPC `generate_replenishment_tasks(warehouse)` — evaluates active
  rules, enqueues `wms_tasks(task_type='replenish')` from source →
  pick face, respects `pack_multiple`, dedupes open tasks.
- View `wms_slotting_velocity_view` — rolling 90-day A/B/C.
- UI: `/warehouse-app/replenishment`, `/warehouse-app/slotting`.
- Guard `wms-phase8.test.ts`.

### Phase 9 — Yard & Trailer Management  ✅
- Tables `wms_yard_slots` (master data, biz-scoped RLS) and
  `wms_trailer_visits` (RPC-only writes, `SELECT`-only PostgREST grant).
- RPCs `check_in_trailer`, `assign_trailer_to_dock`, `depart_trailer`
  — all `SECURITY DEFINER`, all emit `warehouse.yard.*` events with
  idempotency key `wms.trailer_visit:<id>:<status>`.
- Server-computed `dwell_minutes` on departure. Auto-park into first
  free yard slot via `FOR UPDATE SKIP LOCKED`.
- Appointment ↔ visit ↔ dock linkage: RPCs advance
  `wms_dock_appointments` state in lock-step when `appointment_id` is
  provided.
- UI: `/warehouse-app/yard` — two-pane arrivals board + yard map, 15s
  auto-refresh, check-in / assign-to-dock / depart-with-seal dialogs.
- Guard `wms-phase9.test.ts` — blocks direct writes to
  `wms_trailer_visits`, restricts `wms_yard_slots` writes to the Yard
  page, asserts RPCs + route + nav.
- ADR `docs/adr/0080-wms-yard-management.md`.

---

## 3. What is NOT yet implemented (in order)

### Phase 10 — Labour management  ✅
- `wms_task_standards` (biz-scoped master data: `task_type, uom,
  seconds_per_uom, is_active`). PostgREST writes gated by
  `inventory:write` permission.
- `wms_tasks.earned_seconds` / `.actual_seconds` added. Stamped by
  BEFORE-UPDATE trigger `_wms_stamp_labour_metrics` on transition into
  `state='done'`. Direct client writes to those columns are blocked at
  the DB — no changes needed to any existing `complete_*_task` RPC.
- View `wms_operator_productivity_view` (`security_invoker=true`) —
  earned/actual seconds, tasks completed, utilisation ratio per
  `(operator, warehouse, day)`.
- UI: `/warehouse-app/labour` — KPI cards, operator leaderboard,
  standards CRUD (create / toggle active / delete).
- Guard `wms-phase10.test.ts`.
- ADR `docs/adr/0081-wms-labour-management.md`.

---

## 3. What is NOT yet implemented (in order)

### Phase 11 — 3PL activity-based billing  ✅
- `wms_billing_tariffs` (biz-scoped master data; PostgREST writes
  gated by `inventory:write`). UNIQUE
  `(business_id, client_business_id, activity, uom, effective_from)`;
  `client_business_id IS NULL` = default/fallback rate.
- `wms_billable_activities` (RPC-only ledger, UNIQUE
  `(business_id, source_event_id)` for idempotency, `invoice_id`
  stamped when folded into a draft Sales invoice).
- RPCs `capture_billable_activity`,
  `capture_pending_billable_activities`, `generate_3pl_invoice`
  — all `SECURITY DEFINER`, business-access checked.
- Pure IMMUTABLE `_wms_map_event_to_activity` maps
  `warehouse.*` events to activity codes; single source of truth
  for "which events bill".
- Draft invoices land in `public.invoices` with prefix
  `3PL-YYYYMM-<client8>` so AR/dunning inherits the receivable.
- View `wms_billable_activities_summary_view`
  (`security_invoker=true`).
- UI: `/warehouse-app/billing` — tariff CRUD, activity summary,
  capture-events button, month-end invoice generation dialog.
- Guard `wms-phase11.test.ts`.
- ADR `docs/adr/0082-wms-3pl-activity-billing.md`.

---

## 3. What is NOT yet implemented (in order)

### ▶ Phase 12 — Cross-dock & cartonization  **← START HERE NEXT**

Only after Phase 11 lands (done). Cross-dock uses
inbound-to-outbound task chaining (a receipt that satisfies an
open sales-order pick skips putaway → staging → dispatch);
cartonization needs product dims + a carton catalogue and picks
the right carton at pack-time.

### Phase 13 — Returns & RMA execution surface

Inventory has `purchase_returns` / `sales_returns` tables; WMS needs a
return-authorization intake, a return-receiving workflow, and
disposition routing (restock / QC-hold / scrap / RTV) as first-class
tasks. QC 7.1 handles the RTV *seed* but not the inbound return dock.

### Phase 14 — Kitting / light manufacturing / VAS

`wms_kit_orders`, VAS task type, consumption of components +
production of kits under `stock_movements`. Prerequisite for 3PL
clients that assemble bundles or gift-with-purchase.

### Phase 15 — Hazmat, lot genealogy, and recall execution

Existing `product_recalls` / `product_recall_items` need a WMS
execution layer: freeze bins, generate quarantine-move tasks, and
reconcile recovered vs shipped quantities.

### Phase 16 — Operator RF/mobile surface

Current pages are supervisor-desktop. A scan-first mobile execution
layer (barcode-driven task loops) is required for real warehouse
floors; hooks into existing scanner infra (`scan_events`,
`scanner_sessions`).

---

## 4. Explicitly out of scope this track

- AQL sampling automation, vendor-portal RTV, predictive QC.
- Cost-layer / AVCO changes (owned by Inventory, ADR 0078).
- Voice-pick / RF-gun hardware integration (post Phase 16).
- WCS/WES integration for automated MHE (separate track).

---

## 5. Handoff — exact starting point for next agent

**File to open first:** this plan.
**Second:** `docs/adr/0080-wms-yard-management.md` — most recent charter.
**Third:** the Phase 9 migration
`supabase/migrations/20260717225958_*.sql` — mirror its structure for
Phase 10 (table + column adds + RPC updates + view + guard).

**First commands to run (parallel):**

1. `code--view src/pages/warehouse/YardBoard.tsx` — copy this page's
   shape (list + map + dialogs + RPC calls) for the Labour page.
2. `code--view supabase/migrations/20260717214600_*_qc_inspections.sql`
   — copy the `emit_business_event` + idempotency-key pattern (still
   canonical).
3. `rg "complete_task\b" supabase/migrations` — Phase 10 must extend
   every task-completion RPC to stamp `earned_seconds` /
   `actual_seconds`.

**First edit:** new migration
`supabase/migrations/<ts>_wms_phase10_labour.sql` per §3 Phase 10 spec.
Then Supabase types regen. Then Labour page. Then guard test. Then
update this plan (move Phase 10 to §2, promote Phase 11 to "START HERE
NEXT").

**Do not** start Phase 11 work until Phase 10 DoD is 100% green.
