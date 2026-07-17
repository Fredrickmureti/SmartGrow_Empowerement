
# Enterprise WMS — Audit Verdicts & Build Plan

## 0. Framing

Inventory Management (what/how much/whose/value/lot/expiry) is already **enterprise-grade** — the last 15 ADRs (0064–0078) delivered locations+quants, lot genealogy, serial ledger, downstream stamping, stock event fabric, landed cost, 3-way match. That work is verified live in DB.

Warehouse Management (where physically / who moves / which task / which dock / which pallet / which wave / which pick path) is **not**. What exists today at `/inventory-app/warehouses` is a CRUD list of warehouse *records* (name, address, manager). Even though `stock_locations` supports a full hierarchy, only one auto-seeded default row per warehouse exists, and **zero** operational tables model the physical workflow.

This plan treats WMS as a new execution layer that sits above Inventory. Inventory remains the single source of truth for stock ownership/quantities. WMS owns physical location, operator, task, appointment, dock, wave, pick, pack, load, dispatch.

## 1. Verdicts (evidence-based)

| Pillar | Verdict | Why |
|---|---|---|
| Warehouse master (site/branch/DC/store/dark-store) | Needs improvement | `warehouses` is a flat record. No `warehouse_type` (DC/store/dark/3PL), no operating hours, no dock count, no capacity, no calendar. |
| Warehouse layout (zones/aisles/racks/bins/pallets) | Architecturally wrong (for WMS) | Schema (`stock_locations`) supports hierarchy correctly, but only one `is_default` row is auto-seeded and **no UI exists to author zones/aisles/racks/bins**. Pallet/LPN concept is absent (`package_id` column reserved but no `license_plates` table). |
| Receiving workflow (ASN → appointment → dock → unload → inspect → GRN) | Needs improvement | `inbound_shipments` (ASN) and `goods_receipts` exist, but there is **no receiving appointment, no dock schedule, no dock door assignment, no unload/inspection step separated from GRN**. Receiving today = "click 'receive' → stock increments." |
| Put-away | Architecturally missing | No `putaway_tasks`, no putaway strategy (fixed/nearest/directed), no operator confirmation. Received stock lands directly on the default location. |
| Picking (sales/transfer/mfg/replenishment) | Architecturally missing | No `pick_lists`, no `pick_tasks`, no wave/batch/cluster picking, no pick path optimization, no operator assignment. Sales orders debit stock in aggregate. |
| Packing | Architecturally missing | No `pack_stations`, no cartonization, no `packages`/`shipment_units` with weight/dim. `delivery_notes` exist but skip the pack step. |
| Loading + Dispatch (staging → dock → truck) | Needs improvement | `delivery_notes` + `delivery_proofs` exist; no `loading_task`, no `dock_out` appointment, no shipment-manifest grouping. |
| Warehouse transfers (WH-to-WH, bin-to-bin, zone-to-zone) | Needs improvement | WH-to-WH ✅ (`stock_transfers`, ADR 0068 split, transit location). Bin-to-bin / zone-to-zone is impossible today because writers never stamp `source_location_id` / `destination_location_id`. |
| Warehouse tasks / operator work queue | Architecturally missing | `project_tasks` is domain-scoped to projects; no `wms_tasks` table, no operator queue, no priority, no SLA, no scan-to-confirm. |
| Warehouse operators / roles | Needs improvement | Users exist; no WMS role vocabulary (Picker/Packer/Loader/Receiver/Supervisor/QC), no shift-linked assignment, no productivity ledger. |
| Cycle count / physical count | Correct | `physical_counts`, `cycle_count_schedules`, `physical_count_lines` are enterprise-shaped. Bin-level counts unlock naturally when bins exist. |
| Quarantine / QC | Needs improvement | `lot_quarantine` + quarantine `location_type` exist (ADR 0065). No **QC inspection workflow** (hold → sample → pass/fail → release/scrap → GL). |
| Location intelligence (where is batch X?) | Blocked | `stock_quants` is location-aware and works, but because writers don't stamp real bins, every quant currently sits on `<warehouse>/default`. The engine is right; the input is empty. |
| Integration (WMS ↔ Inventory / PO / SO / Mfg / Finance / Shipping) | Needs improvement | Stock Event Fabric (ADR 0076) is live. Nothing on the WMS side publishes/consumes `receiving.appointment.*`, `putaway.task.*`, `pick.wave.*`, `dispatch.load.*` because those domains don't exist. |

**Executive verdict:** the *inventory* half is enterprise-grade. The *warehouse-execution* half is a stub. We build the WMS layer additively — no rework of the inventory engine.

## 2. Design principles (non-negotiable)

1. **Inventory stays canonical.** WMS never owns stock quantity/value/cost. It emits domain events; `stock_movements` + `stock_quants` remain the ledger.
2. **Every physical action is a task.** Receiving, putaway, picking, packing, loading, counting, cleaning are all rows in one `wms_tasks` table with a typed payload — enables one universal operator queue and one productivity ledger.
3. **Every stock change stamps a real location.** Writers move from `default` bin to real bins as they migrate. Multi-phase, additive.
4. **Every task publishes a business event.** WMS is event-sourced via `business_event_outbox` — same fabric that inventory uses.
5. **License plates (LPNs) unify unit of handling.** Pallet/carton/tote all share one identity; movements can address a plate instead of enumerating contents.
6. **Country-agnostic.** No fiscal, no localization, no currency in WMS tables — inventory + finance handle those already.

## 3. Target module topology

```
apps/warehouse/                     ← new workspace (rail entry)
  routes.tsx
  nav.ts
  WarehouseLayout.tsx
  pages/
    dashboard/                      ← ops KPI: open tasks, dock schedule, backlog
    layout/                         ← zone/aisle/rack/bin CRUD + tree view
    receiving/
      appointments/                 ← book, reschedule, cancel
      dock/                         ← today's dock board
      grn-workspace/                ← unload → inspect → post GRN
    putaway/                        ← task queue, scan-to-confirm
    picking/
      waves/
      tasks/
    packing/
      stations/
      cartonize/
    dispatch/
      loading/
      manifests/
    transfers/                      ← bin-to-bin, zone-to-zone (WH-to-WH stays in inventory)
    tasks/                          ← universal operator queue
    operators/                      ← WMS-role assignment, productivity
    plates/                         ← LPN registry
    qc/                             ← inspection hold + release
```

`/inventory-app/warehouses` (the current CRUD) becomes a redirect to `/warehouse-app/layout` where warehouses live alongside their bin tree; the "records" page is subsumed.

## 4. Data model additions (new tables — additive only)

Every new table follows project rules: `CREATE TABLE` → `GRANT` → `ALTER … ENABLE RLS` → `CREATE POLICY`, all in the same migration.

- `warehouse_types` (enum-backed: dc / store / dark_store / 3pl / fulfillment / cross_dock)
- `warehouse_operating_hours` (per weekday, holiday overrides)
- `warehouse_docks` (dock door per warehouse, in/out, capacity)
- `receiving_appointments` (carrier, PO/ASN, dock, window, status)
- `wms_license_plates` (LPN — pallet/carton/tote; parent_lpn for nesting; current_location_id; sealed flag)
- `wms_tasks` (universal task: type enum {putaway, pick, pack, load, count, replenish, move, qc}; source_doc_type/id; assignee_user_id; state {pending, assigned, in_progress, done, cancelled}; priority; sla_at; started_at; completed_at)
- `putaway_rules` (product/category → target zone/bin, strategy)
- `pick_waves` (wave header: strategy {batch, cluster, discrete, zone}, cutoff, status)
- `pick_wave_lines` (wave line → sales_order_item / transfer_item)
- `pack_stations` (physical station, printer bindings, current operator)
- `shipment_packages` (package / carton grouping delivery_note lines; weight, dim, LPN)
- `loading_manifests` (truck load: dock, carrier, driver, seal, departure)
- `qc_inspections` (inspection lot: source GRN line; sampling plan; result; disposition {release, quarantine, scrap})
- `wms_operator_shifts` (link operator user_id ↔ shift ↔ warehouse role)
- `wms_role` (Picker/Packer/Loader/Receiver/Supervisor/QC/Forklift) via existing `user_roles` app_role enum extension **or** dedicated `wms_operator_roles` table (leaning dedicated to keep app_role clean).

Zone/aisle/rack/bin: **reuse `stock_locations`** — extend `location_type` enum with `zone/aisle/rack/bin/dock/staging_in/staging_out` if not present; add optional `barcode`, `capacity_max_units`, `capacity_max_weight`, `pick_sequence` columns. No new table needed for the hierarchy itself.

## 5. Event contract (published via `business_event_outbox`)

`warehouse.appointment.booked` / `.arrived` / `.cancelled`
`warehouse.grn.inspected` (in addition to existing `stock.movement.received`)
`warehouse.putaway.task_generated` / `.confirmed`
`warehouse.pick.wave_released` / `.task_confirmed`
`warehouse.pack.completed`
`warehouse.load.sealed` / `.departed`
`warehouse.qc.inspection_completed`
`warehouse.plate.moved`

Emitted from DB triggers on state transitions of the tables above, mirroring `tg_stock_movement_emit_event`.

## 6. Phased delivery (each phase is independently shippable, no regression)

**Phase 0 — Scaffolding (this session, if approved).**
- Create `src/apps/warehouse/` workspace, rail entry, nav, `WarehouseLayout` with `BranchScopeGate`.
- Redirect `/inventory-app/warehouses*` → new app; keep the CRUD forms working from the new location so no functionality is lost.
- One "Warehouse Layout" page: reads `stock_locations`, renders the bin tree, allows create/edit/soft-retire of zone/aisle/rack/bin under a warehouse (extends `stock_locations.location_type` enum). No writers changed yet.
- Architecture test: new app registered; nav present; guard against re-adding CRUD to `/inventory-app/warehouses`.

**Phase 1 — LPN + Tasks primitives.**
- Migrations: `wms_license_plates`, `wms_tasks`. GRANTs + RLS + org/business scope.
- Task queue page: filter by type/state/assignee. No workflow yet — just the substrate.
- Domain events: `warehouse.task.*` type additions.

**Phase 2 — Receiving execution layer.**
- Migrations: `warehouse_docks`, `receiving_appointments`. Trigger: on GRN post, emit `warehouse.grn.inspected` if inspection task exists; else post-and-inspect same-step.
- UI: dock board (today's appointments), appointment CRUD, inspection panel on GRN detail.
- Existing `goods_receipts` unchanged — appointment references it; RPC `post_goods_receipt_with_location(bin_id)` lets receivers stamp destination bin.

**Phase 3 — Putaway.**
- Migrations: `putaway_rules`. `wms_tasks` gains `putaway` type.
- Trigger on GRN post → generates `wms_tasks(type=putaway)` per line using rules; default rule is "warehouse default bin" (backwards compat).
- Operator confirms → RPC moves `stock_quants` from receiving-staging to target bin (a real `stock_movements` row with source+dest location).

**Phase 4 — Picking + Packing.**
- Migrations: `pick_waves`, `pick_wave_lines`, `pack_stations`, `shipment_packages`.
- Sales order fulfillment splits: reserve → wave → pick tasks → pack → delivery note (existing) → load.
- Bin-to-bin transfer becomes trivial (already supported by `stock_movements` now that source/dest bin is stamped).

**Phase 5 — Loading + Dispatch.**
- Migrations: `loading_manifests`. Trigger emits `warehouse.load.sealed/departed`.
- Delivery notes group under manifests; dock-out appointment mirror of dock-in.

**Phase 6 — QC + Quarantine workflow.**
- Migrations: `qc_inspections`. Wires to existing `lot_quarantine` + quarantine `location_type`.

**Phase 7 — Operator productivity + shift assignment.**
- Migrations: `wms_operator_roles`, `wms_operator_shifts`. Reports: tasks/hour, avg pick time, error rate.

Only Phase 0 executes in the next session unless the user explicitly authorises further phases in one go.

## 7. What we will NOT do

- No rework of `stock_movements`, `stock_quants`, `stock_lots`, `stock_serials`, `warehouse_stock*`. Inventory foundation is right.
- No deletion of `/inventory-app/warehouses` route — it redirects, preserving deep links.
- No new cost/valuation logic. AVCO stays canonical (ADR 0002 + 0078).
- No POS/finance/localization changes.

## 8. Success criteria for the WMS layer

At the end of Phase 5 we can answer, from data alone: *"For SKU X batch Y — which bin is it in, which putaway operator placed it there and when, which pick wave will consume it next, which packer will carton it, which manifest will ship it, on which truck, out of which dock, at what time."* Today none of those questions has an answer.

## 9. Ask for confirmation

Before scaffolding Phase 0, please confirm:
1. Green-light the module topology in §3 and the phased order in §6?
2. OK to redirect `/inventory-app/warehouses` into the new `/warehouse-app/*` workspace (deep links preserved)?
3. Any warehouse pattern to prioritise first: **retail multi-branch**, **DC/fulfillment**, **pharmacy cold-chain**, or **generic**? (Drives which fields we surface earliest on `warehouses`.)

---

## 10. Session 9 — Handoff Log (Phase 0 shipped)

**Date:** 2026-07-17. **Status:** Phase 0 complete and verified (`bunx tsgo --noEmit` clean).

### What is live (verifiable in code + DB)

1. **DB — `stock_locations` extended** (migration accepted last turn):
   - Added `structure_level` (enum-like text: `zone | aisle | rack | shelf | bin | dock | staging_in | staging_out`), `barcode`, `capacity_max_units`, `capacity_max_weight`, `pick_sequence`.
   - No writers changed, no data migration required — additive only. Existing auto-seeded `is_default` rows still work.

2. **App registered** — `src/lib/apps/registry.ts`:
   - `WAREHOUSE_APP` (id `warehouse`, basePath `/warehouse-app`, `sortOrder: 5.5`, `internalOnly: true`, color orange to distinguish from Inventory purple).
   - Listed in `APP_REGISTRY` right after `INVENTORY_APP`.

3. **App mounted** — `src/App.tsx`:
   - `WarehouseApp` lazy-loaded, mounted at `/warehouse-app/*` behind `SubscriptionProtectedRoute` → `PortalUserRoute` → `AppInstalledGate appId="warehouse"`.

4. **App workspace** — `src/apps/warehouse/`:
   - `nav.ts` — **only real routes are wired**. Overview, Warehouses, Layout. No placeholder entries.
   - `WarehouseLayout.tsx` — `PlatformShell` + `BranchScopeGate`.
   - `routes.tsx` — Dashboard, Warehouses (reusing existing Inventory CRUD), Warehouse view/new/edit, Layout editor. **No coming-soon routes.**
   - `index.ts` — clean re-exports.

5. **Pages built** — `src/pages/warehouse/`:
   - `WarehouseDashboard.tsx` — 3 real KPIs (warehouses count, total locations, authored bins), plus a conditional "author your layout" call-to-action shown only when the org has locations but zero `structure_level` rows. No fake tiles.
   - `WarehouseLayoutPage.tsx` — real, working editor. Warehouse selector; queries `stock_locations` scoped to warehouse; renders a collapsible tree (sorted by `pick_sequence` then `code`); "Add zone" / "Add child" opens dialog to create zone/aisle/rack/shelf/bin/dock/staging with barcode + pick sequence; writes go through `supabase.from("stock_locations").insert(...)` with org/business/branch stamped and `location_type='internal'`, `usage` inferred from level. Invalidates dashboard KPI queries on success.

### What is deliberately NOT done (do not re-litigate)

- No "coming soon" pages, no dead nav links, no placeholder routes anywhere. `src/pages/warehouse/WmsComingSoon.tsx` was deleted.
- No changes to any inventory writer (`stock_movements`, GRN, transfer, POS, sale). Inventory foundation stays untouched per §7 rule.
- Legacy `/inventory-app/warehouses` route is still present. Redirects into the new app are safe to add now that Phase 0 works; scheduled for the start of the next session so it lands with a passing architecture test.

### Verification pointers for the next agent

- Type check: `bunx tsgo --noEmit` — must stay clean.
- Route smoke test: navigate to `/warehouse-app` — should redirect to `/warehouse-app/dashboard` and render 3 KPI cards from live data.
- Layout editor smoke test: pick any warehouse in the selector, add a zone, confirm it appears in the tree and the "Authored bins / zones" KPI on the dashboard increments.
- Registry test: `WAREHOUSE_APP` in `APP_REGISTRY`; `id === "warehouse"`, `basePath === "/warehouse-app"`.
- DB check: `select column_name from information_schema.columns where table_name='stock_locations' and column_name in ('structure_level','barcode','capacity_max_units','capacity_max_weight','pick_sequence');` — all five must be present.

### Phase 1 — pick up here (build, do not defer)

**Goal:** ship LPN + universal WMS task substrate end-to-end. No placeholders. When Phase 1 lands, the sidebar gains **License plates** and **Operator tasks** entries — both fully functional.

Deliverables, in build order:

1. **Migration `wms_phase1_lpn_and_tasks`** (single migration, all four steps per project rules):
   - `public.wms_license_plates` — `id`, `code` (unique per business), `lpn_type` (`pallet | carton | tote | other`), `parent_lpn_id` (self-fk, nullable, for nesting), `current_location_id` fk `stock_locations`, `warehouse_id`, `organization_id`, `business_id`, `branch_id`, `sealed_at`, `status` (`open | sealed | shipped | retired`), timestamps + trigger.
   - `public.wms_tasks` — `id`, `task_type` (`putaway | pick | pack | load | count | replenish | move | qc`), `state` (`pending | assigned | in_progress | done | cancelled`), `priority int`, `sla_at`, `assignee_user_id` (nullable), `warehouse_id`, `source_doc_type` + `source_doc_id`, `source_location_id`, `destination_location_id`, `product_id` (nullable), `lot_number`, `lpn_id`, `quantity`, `started_at`, `completed_at`, org/business/branch scope, timestamps + trigger.
   - GRANT SELECT/INSERT/UPDATE/DELETE to `authenticated`; GRANT ALL to `service_role`. No `anon` grants — both tables scope by `auth.uid()` via business membership (mirror `stock_locations` policy shape).
   - RLS policies scoped to `business_id` using the org-membership helper the project already uses on inventory tables (grep `stock_locations` policies for the exact predicate — reuse it verbatim to stay consistent).
   - Trigger `tg_wms_task_emit_event` mirroring `tg_stock_movement_emit_event`: on state transitions to `assigned`, `in_progress`, `done`, `cancelled`, insert into `business_event_outbox` with event types `warehouse.task.assigned` / `.started` / `.completed` / `.cancelled`. Idempotency key `wms.task:<task_id>:<state>`. Wrap in `EXCEPTION WHEN OTHERS THEN RAISE WARNING` per ADR 0076.
   - Trigger `tg_wms_lpn_emit_event`: emit `warehouse.plate.moved` when `current_location_id` changes; `warehouse.plate.sealed` when `sealed_at` transitions from null.

2. **Domain event types** — add to `src/services/events/domainEventBus.ts` `DomainEventType`:
   - `warehouse.task.assigned | warehouse.task.started | warehouse.task.completed | warehouse.task.cancelled`
   - `warehouse.plate.moved | warehouse.plate.sealed`
   Register minimal saga handlers in `src/components/events/BusinessSagaMount.tsx` (log-only for now; proves fabric wiring).

3. **UI — License plates** (`src/pages/warehouse/LicensePlates.tsx` + `LicensePlateView.tsx` + create dialog):
   - List page: filters (warehouse, type, status), search by code, table with code / type / status / current location / parent / sealed_at.
   - Create: code (auto-generate `LPN-<yy><random6>` unless overridden), type, warehouse, optional parent LPN.
   - Detail: current location, contents summary (aggregate `stock_quants` where `package_id` maps to this LPN — reserved column exists on `stock_quants`), move action (posts to a new `move_lpn` RPC or a plain update — decide during build; RPC is cleaner because it records the event atomically), seal action.
   - Wire in `nav.ts` under a new "Master" group only after the page is functional.

4. **UI — Operator tasks** (`src/pages/warehouse/OperatorTasks.tsx` + row detail sheet):
   - Universal queue: filters (type, state, warehouse, assignee, priority), sort by priority desc then `sla_at` asc.
   - Row actions: claim (set assignee=me, state=assigned), start (state=in_progress, started_at=now), complete (state=done, completed_at=now — user must supply destination if applicable), cancel with reason.
   - No task-creation UI in Phase 1 — tasks are seeded from Phase 2/3/4 domain events. For Phase 1, add a tiny "create ad-hoc move task" form so operators can test the queue before receiving/putaway ship. Wire nav entry after page is functional.

5. **Architecture test** (`src/test/architecture/wms-phase1.test.ts`):
   - Assert `WAREHOUSE_APP` includes `plates` and `tasks` modules.
   - Assert `nav.ts` contains those entries.
   - Assert new migration file exists and contains `CREATE TABLE public.wms_license_plates` + `CREATE TABLE public.wms_tasks` + GRANTs + RLS.
   - Assert `DomainEventType` union includes the six new `warehouse.*` events.

6. **Redirect legacy inventory warehouses route** — add `<Route path="warehouses/*" element={<Navigate to="/warehouse-app/warehouses" replace/>} />` (with deep-link path preservation) in `src/apps/inventory/routes.tsx`, remove the warehouse entry from `INVENTORY_NAV`, and add an eslint architecture check that `/inventory-app/warehouses` is not authored under `src/pages/`.

**Do not:** add placeholder pages, add nav entries pointing at unbuilt routes, or split Phase 1 across sessions. Phase 1 ships as one PR-equivalent atomic step.

Once Phase 1 is verified live, continue with Phase 2 (Receiving execution layer) per §6 — same "build, don't defer" discipline.

