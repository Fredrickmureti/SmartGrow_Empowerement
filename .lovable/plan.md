
# WMS — Verification results & Phase 1 execution plan

## Phase 0 verification (independent, from code + DB)

Phase 0 as logged in `.lovable/plan.md` §10 is **genuinely complete**. Confirmed:

- DB — `stock_locations` has all 5 additive columns: `structure_level`, `barcode`, `capacity_max_units`, `capacity_max_weight`, `pick_sequence` (queried `information_schema.columns`).
- Registry — `WAREHOUSE_APP` present in `src/lib/apps/registry.ts` at basePath `/warehouse-app`, listed in `APP_REGISTRY`.
- Mount — `WarehouseApp` lazy-mounted at `/warehouse-app/*` in `src/App.tsx` behind subscription + `AppInstalledGate`.
- Workspace — `src/apps/warehouse/{routes,nav,WarehouseLayout,index}.tsx` all present, nav only exposes real routes (Overview / Warehouses / Layout).
- Pages — `WarehouseDashboard.tsx` (138 LOC, real KPIs) and `WarehouseLayoutPage.tsx` (403 LOC, real editor writing `stock_locations`) exist. No placeholder pages.
- No `wms_license_plates` or `wms_tasks` tables exist yet — Phase 1 is genuinely pending, not silently half-shipped.

Nothing to redo. Resume at Phase 1.

## Gaps found while auditing (append to the plan)

1. **ADR 0079 is referenced in nav.ts and routes.tsx but no file exists** under `docs/adr/`. Author it alongside the Phase 1 migration so the split (Inventory = ledger, Warehouse = execution) is recorded, not just implied by code comments.
2. **Legacy `/inventory-app/warehouses` route still live** — plan §10 deferred the redirect to "start of next session". Bundle it into Phase 1 so the app has one canonical warehouse master surface.
3. **`stock_quants.package_id` exists** (confirmed) — good, LPN contents can be aggregated without schema change.
4. **`business_event_outbox.event_type` is free-form text** (not an enum) — no DB migration needed to add `warehouse.task.*` / `warehouse.plate.*` event names; only the client-side `DomainEventType` union grows.

## Phase 1 — build order (single session, no placeholders)

### 1. Migration `wms_phase1_lpn_and_tasks`
One migration file, four-step structure per project rules (CREATE → GRANT → RLS → POLICY), covering:

- `public.wms_license_plates`: `id`, `code` (unique per business), `lpn_type` enum (`pallet|carton|tote|other`), `parent_lpn_id` (self-fk), `current_location_id` → `stock_locations`, `warehouse_id`, org/business/branch scope, `status` (`open|sealed|shipped|retired`), `sealed_at`, timestamps + updated_at trigger.
- `public.wms_tasks`: `id`, `task_type` (`putaway|pick|pack|load|count|replenish|move|qc`), `state` (`pending|assigned|in_progress|done|cancelled`), `priority int`, `sla_at`, `assignee_user_id`, `warehouse_id`, `source_doc_type` + `source_doc_id`, `source_location_id`, `destination_location_id`, `product_id`, `lot_number`, `lpn_id`, `quantity`, `started_at`, `completed_at`, org/business/branch scope, timestamps + trigger.
- GRANT SELECT/INSERT/UPDATE/DELETE to `authenticated`; GRANT ALL to `service_role`. No `anon`.
- RLS scoped by `business_id` via the same helper `stock_locations` uses (reuse verbatim).
- Trigger `tg_wms_task_emit_event` → `business_event_outbox` on state transitions (`assigned/started/completed/cancelled`). Idempotency key `wms.task:<id>:<state>`. `EXCEPTION WHEN OTHERS THEN RAISE WARNING` per ADR 0076.
- Trigger `tg_wms_lpn_emit_event` → emits `warehouse.plate.moved` on `current_location_id` change and `warehouse.plate.sealed` when `sealed_at` transitions from null.

### 2. Domain event types
Extend `DomainEventType` in `src/services/events/domainEventBus.ts`:
`warehouse.task.assigned | .started | .completed | .cancelled`
`warehouse.plate.moved | .sealed`
Register log-only saga handlers in `BusinessSagaMount.tsx` to prove wiring.

### 3. UI — License plates
- `src/pages/warehouse/LicensePlates.tsx` — list with filters (warehouse/type/status), search by code, columns: code / type / status / current location / parent / sealed_at.
- `LicensePlateView.tsx` — header + current location + contents summary aggregated from `stock_quants` where `package_id = lpn.id`, actions: **Move** (RPC `move_lpn(lpn_id, dest_location_id)` — atomic update + event), **Seal**, **Retire**.
- Create dialog — auto-generate `LPN-<yy><rand6>`, type, warehouse, optional parent.

### 4. UI — Operator tasks
- `src/pages/warehouse/OperatorTasks.tsx` — universal queue with filters (type/state/warehouse/assignee/priority), sort priority desc → sla_at asc.
- Row actions: **Claim** (assignee=me, state=assigned), **Start**, **Complete**, **Cancel with reason**.
- Ad-hoc "Create move task" form so operators can exercise the queue before downstream phases seed real tasks.
- Detail sheet showing source/destination bin, product/lot, LPN, timeline.

### 5. Nav + routes
Add nav entries `Master → License Plates` and `Operations → Operator Tasks` in `src/apps/warehouse/nav.ts` **only after** both pages are functional. Wire routes in `src/apps/warehouse/routes.tsx`.

### 6. Legacy redirect
In `src/apps/inventory/routes.tsx` add `<Route path="warehouses/*" element={<Navigate to="/warehouse-app/warehouses" replace/>}/>` preserving deep-link path, remove the warehouse nav entry from `INVENTORY_NAV`. Delete no files — CRUD components stay reused from `src/pages/inventory/`.

### 7. ADR 0079 — record the split
Author `docs/adr/0079-inventory-vs-warehouse-split.md`: Inventory owns ledger (quants/movements/cost); Warehouse owns physical execution (LPN/tasks/appointments/waves/manifests). Names the tables so future audits don't re-litigate the boundary.

### 8. Architecture test
`src/test/architecture/wms-phase1.test.ts` asserts:
- Migration file exists and contains `CREATE TABLE public.wms_license_plates` + `CREATE TABLE public.wms_tasks` + GRANT + RLS.
- `nav.ts` includes plates + tasks entries.
- `DomainEventType` union includes the six new `warehouse.*` events.
- `/inventory-app/warehouses` no longer authored as a functional route (only a redirect).

## Success criteria for Phase 1

Type check clean (`bunx tsgo --noEmit`). Navigating to `/warehouse-app/plates` lists LPNs and allows create/move/seal end-to-end with a real event in `business_event_outbox`. `/warehouse-app/tasks` shows the ad-hoc created task moving through pending → assigned → in_progress → done, each transition producing a `warehouse.task.*` outbox row. `/inventory-app/warehouses/<id>` deep-links land on the new app.

## Explicitly out of scope for this phase

Receiving appointments, dock schedule, putaway rule engine, pick waves, pack stations, loading manifests, QC workflow, operator productivity — those are Phases 2–7 in the existing plan and stay untouched. No inventory writer is modified.
