
## Verification of previous engineer's claims

Cross-checked plan.md §2 against the codebase and database:

- **Phases 0–7.1** — tables `wms_license_plates`, `wms_tasks`, `wms_dock_appointments`, `wms_pick_waves`, `wms_pack_cartons`, `wms_loading_manifests`, `wms_count_sessions`, `wms_qc_inspections` all present. Pages under `src/pages/warehouse/` match the claims. Guards `wms-phase1..7.test.ts` present. ✅
- **Phase 8 (Replenishment & slotting)** — table `wms_replenishment_rules` exists, RPC `generate_replenishment_tasks` exists, pages `Replenishment.tsx` + `Slotting.tsx` exist, guard `wms-phase8.test.ts` exists, nav wired. ✅
- **Phase 9 (Yard & Trailer)** — `wms_yard_slots`, `wms_trailer_visits` absent; RPCs `check_in_trailer`, `assign_trailer_to_dock`, `depart_trailer` absent; no yard page, no nav entry. **Not started — correct resumption point.**

No regressions or hollow implementations spotted at the checkpoints inspected. Resume exactly where plan.md §3 says.

## Phase 9 — Yard & Trailer Management

Turn dock appointments into a live yard-ops signal (dwell, on-time, detention, seal capture).

### Migration 1 — master + operational tables

`wms_yard_slots` (business-scoped master data, PostgREST writes for warehouse admins):
`id, business_id, warehouse_id, code, slot_type (inbound|outbound|either|hazmat|reefer), status (available|occupied|blocked), notes, timestamps`.

`wms_trailer_visits` (RPC-only writes):
`id, business_id, warehouse_id, carrier_id, trailer_ref, driver_name, driver_phone, seal_in, seal_out, yard_slot_id, dock_id (→ wms_dock_appointments dock), appointment_id (→ wms_dock_appointments), arrived_at, docked_at, departed_at, status (arrived|in_yard|at_dock|departed|no_show)`.

Both: GRANTs to `authenticated` + `service_role`, RLS scoped via `user_business_access`, updated_at trigger.

### Migration 2 — RPCs (SECURITY DEFINER, all emit events)

- `check_in_trailer(warehouse_id, carrier_id, trailer_ref, driver_name, driver_phone, seal_in, appointment_id?)` — creates visit, auto-parks into first available yard slot, marks slot `occupied`, status `arrived` (or `in_yard` if parked). Emits `warehouse.yard.checked_in`, idempotency `wms.trailer_visit:<id>:checked_in`.
- `assign_trailer_to_dock(visit_id, dock_id)` — validates dock free, links visit, frees yard slot, stamps `docked_at`, status `at_dock`, links + updates `wms_dock_appointments` if provided. Emits `warehouse.yard.docked`.
- `depart_trailer(visit_id, seal_out)` — stamps `departed_at`, releases dock/slot, status `departed`, computes dwell server-side. Emits `warehouse.yard.departed`.

Mirror the `emit_business_event` pattern from `20260717214600_*_qc_inspections.sql`.

### Frontend

- New page `src/pages/warehouse/YardBoard.tsx` — two-pane:
  - Left: **Arrivals board** — visits list, filters by status, actions (check-in dialog, assign-to-dock, depart-with-seal).
  - Right: **Yard map** — slot grid coloured by status, click reveals occupying visit.
- Route `/warehouse-app/yard` in `src/apps/warehouse/routes.tsx`.
- Nav entry "Yard" under Operations in `src/apps/warehouse/nav.ts` (icon `ParkingSquare` or similar).
- Reuse shape from `Replenishment.tsx` (RPC call + live query + dialog).

### Guard test

`src/test/architecture/wms-phase9.test.ts`:
- No client-side inserts/updates to `wms_trailer_visits` (RPC-only).
- Yard page invokes the three RPCs.
- Route + nav wired.
- Master-data writes on `wms_yard_slots` restricted to the Yard master page.

### ADR

`docs/adr/0080-wms-yard-management.md` — capture appointment ↔ visit ↔ dock linkage, dwell computation contract, event names.

### Definition of done

- [ ] Both migrations applied, types regenerated.
- [ ] Three RPCs emit events with correct idempotency keys.
- [ ] Yard page end-to-end: check-in → assign-to-dock → depart.
- [ ] Guard test green.
- [ ] plan.md updated: Phase 9 moved to §2, Phase 10 marked "START HERE NEXT".
- [ ] ADR 0080 committed.

## After Phase 9

Continue chronologically per plan.md §3: **Phase 10** (labour management — `wms_task_standards`, earned/actual seconds, productivity view, `/warehouse-app/labour`), then **Phase 11** (3PL activity-based billing — tariffs, event-driven `wms_billable_activities`, month-end invoice RPC, `/warehouse-app/billing`), then **Phase 12** (cross-dock + cartonization). Each phase ships migrations + RPCs + UI + guard test + plan/ADR update, no skipping.

## Plan-validation additions (append to plan.md when Phase 9 lands)

Reasoning across the parent prompt vs current state surfaced gaps not in the existing plan. Add these as new phases after 12 rather than expanding scope now:

- **Phase 13 — Returns & RMA execution surface.** Inventory has `purchase_returns` / `sales_returns` tables; WMS has no return-authorization intake, no return receiving workflow, no disposition routing (restock / QC-hold / scrap / RTV) as first-class tasks. QC 7.1 handles the RTV *seed* but not the inbound return dock.
- **Phase 14 — Kitting / light manufacturing / VAS.** No `wms_kit_orders` or value-added-service task type; enterprise 3PL clients require this alongside billing (Phase 11).
- **Phase 15 — Hazmat, lot genealogy, and recall execution.** Tables `product_recalls` / `product_recall_items` exist on the inventory side but no WMS execution layer to freeze bins, generate quarantine-move tasks, and reconcile.
- **Phase 16 — Operator RF/mobile surface.** Current pages are supervisor-desktop. A scan-first mobile execution layer (barcode-driven task loops) is required for real warehouse floors; hooks into existing scanner infra (`scan_events`, `scanner_sessions`).

These are appended, not inserted — Phases 9–12 remain the immediate chronological path.

## Technical notes

- Follow the four-step migration structure: `CREATE TABLE` → `GRANT` → `ALTER TABLE … ENABLE RLS` → `CREATE POLICY`. `wms_trailer_visits` policies must forbid direct writes (only `service_role`); RPCs use `SECURITY DEFINER`.
- Idempotency-key convention `wms.<entity>:<id>:<state>` matches Phases 1–8.
- Do NOT touch `stock_movements` in Phase 9 — yard has no stock effect until dock hand-off, which is already covered by receiving (Phase 2) and dispatch (Phase 5).
- No changes to Inventory-owned tables, cost, or valuation (ADR 0079 non-goals).
