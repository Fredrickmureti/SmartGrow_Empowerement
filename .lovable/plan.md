
# WMS continuation — Phase 12 shipped ✅ · Phase 13 next

## Phase 12 — Cross-dock & cartonization (SHIPPED)

**Delivered:**
- Migration `20260717233..._wms_phase12_crossdock_cartonization.sql`: `wms_carton_types` + `wms_crossdock_opportunities` tables (GRANT + RLS + policies), `wms_pack_cartons.carton_type_id` column, RPCs `evaluate_crossdock_on_grn`, `confirm_crossdock_stage`, `cancel_crossdock_opportunity`, `suggest_carton`, `assign_carton_to_pack`, and `AFTER UPDATE OF status` trigger on `goods_receipts` that auto-evaluates on GRN completion.
- Event fabric: `warehouse.crossdock.matched|staged|cancelled` published through `emit_crossdock_event` with idempotency key `wms.crossdock_opportunity:<id>:<status>`.
- UI: `src/pages/warehouse/CrossdockBoard.tsx` and `src/pages/warehouse/CartonTypes.tsx`, wired at `/warehouse-app/crossdock` and `/warehouse-app/cartons`; nav updated (Operations → Cross-dock, Master → Carton catalogue).
- Guard: `src/test/architecture/wms-phase12.test.ts` — 5/5 green (RPC-only on opportunities, page-scoped writes on carton catalogue, no direct `carton_type_id` writes on pack cartons, RPC call assertions, nav+route wiring).
- ADR `docs/adr/0083-wms-crossdock-cartonization.md`.

**Phase 12.1 follow-up (deferred):** wire `PackStation.tsx` to call `suggest_carton` before submit and pre-select the returned carton type. RPC exists; just need UI wiring.

---

# START HERE NEXT — Phase 13



## Phase 1 — Verification of previous engineer's work

I audited the parent prompt, `.lovable/plan.md`, and the actual codebase.

**Confirmed shipped (evidence in tree, not just plan claims):**

| Phase | Evidence |
|---|---|
| 0 Scaffolding + layout editor | `src/apps/warehouse/*`, `stock_locations` extended (23 cols), `WarehouseLayoutPage.tsx` |
| 1 LPN + tasks | `wms_license_plates`, `wms_tasks` (28 cols) |
| 2 Receiving | `wms_dock_appointments`, `AppointmentPlanner.tsx`, `ReceiveToWMSDialog.tsx` |
| 3 Put-away | `wms_putaway_suggestions`, `PutawayQueue.tsx` |
| 4 Picking & waves | `wms_pick_waves`, `wms_pick_wave_lines`, `WavePlanner.tsx`, `PickList.tsx` |
| 5 Packing & dispatch | `wms_pack_cartons`, `wms_loading_manifests`, `wms_manifest_cartons`, `PackStation.tsx`, `LoadingBay.tsx` |
| 6 Cycle counts | `wms_count_sessions`, `wms_count_lines`, `CycleCounts.tsx` |
| 7 / 7.1 QC | `wms_qc_inspections`, `wms_qc_hold_reasons`, `wms_qc_inspection_checks`, `QCQueue.tsx` |
| 8 Replenishment + slotting | `wms_replenishment_rules`, `Replenishment.tsx`, `Slotting.tsx` |
| 9 Yard | `wms_yard_slots`, `wms_trailer_visits`, `YardBoard.tsx`, ADR 0080 |
| 10 Labour | `wms_task_standards`, `LabourBoard.tsx`, ADR 0081 |
| 11 3PL billing | `wms_billing_tariffs`, `wms_billable_activities`, `BillingBoard.tsx`, ADR 0082 |

**Guards `wms-phase9/10/11.test.ts` all green** (ran locally, 15/15 pass). Nav in `src/apps/warehouse/nav.ts` wires exactly the built pages — no dead links.

No regressions detected. Non-negotiables (Inventory owns quantity; wms_* RPC-only for state; every transition emits `warehouse.*` event with `wms.<entity>:<id>:<state>` idempotency key; per-phase architecture guard) still enforced by tests. Plan file is in sync with reality — the previous agent did update it (Phase 11 marked ✅, Phase 12 marked as START HERE NEXT). Resuming exactly there.

## Phase 2 — Plan validation

Existing plan's phase order (12 → 13 → 14 → 15 → 16) still makes domain sense; no reordering needed. One clarification I'll fold into Phase 12: cartonization needs a **cascade** of dims (product → variant → carton catalogue) and must degrade gracefully when dims are missing — otherwise pack stations block on incomplete master data. Adding that as an explicit sub-item; no new phase needed.

## Phase 3 — Phase 12 execution plan (start here)

**Goal:** cross-dock (skip putaway when an inbound line satisfies an open outbound demand) + cartonization (pick the smallest carton that fits at pack time).

### 3.1 Schema (single migration `<ts>_wms_phase12_crossdock_cartonization.sql`)

New tables (all biz-scoped, standard 4-step: CREATE → GRANT → RLS → POLICY):

- `wms_carton_types` — master data (PostgREST writes, gated by `inventory:write`):
  `code, name, length_cm, width_cm, height_cm, max_weight_kg, tare_weight_kg, cost, is_active`.
- `wms_crossdock_opportunities` — RPC-only ledger:
  `grn_line_id, sales_order_line_id | transfer_line_id, product_id, quantity, matched_at, consumed_at, cancelled_at, reason`.
  UNIQUE `(business_id, source_line_id)` for idempotency; `invoice_id`-style stamping via `pick_task_id` once consumed.

Column adds:
- `wms_pack_cartons.carton_type_id` (nullable FK) — records which carton was chosen at pack.
- `wms_tasks` gains sentinel `task_type='crossdock_stage'` (no schema change; polymorphic already).

### 3.2 RPCs (all `SECURITY DEFINER`, emit `warehouse.*` events with `wms.<entity>:<id>:<state>` keys)

- `evaluate_crossdock_on_grn(grn_id)` — invoked by trigger `trg_wms_crossdock_on_grn_complete` after GRN completion; for each received line, scans open pick-wave demand + pending transfers FEFO/FIFO, inserts `wms_crossdock_opportunities`, and **replaces the putaway task with a `crossdock_stage` task** that routes LPN to the outbound staging bin.
- `confirm_crossdock_stage(task_id)` — operator confirms; posts `stock_movements` GRN-dock → outbound-staging in one hop, marks opportunity `consumed_at`, links the existing pick task's source location to the staging bin so downstream pack/dispatch is unchanged.
- `cancel_crossdock_opportunity(id, reason)` — reverts to a normal putaway task; emits `warehouse.crossdock.cancelled`.
- `suggest_carton(product_ids[], quantities[])` — pure, IMMUTABLE where possible; walks `wms_carton_types` sorted by volume asc, returns the smallest that fits by volume AND weight using product dims (fallback: `product_packaging` when product dims are NULL; if both NULL, returns NULL — pack UI shows "manual carton" prompt).
- `assign_carton_to_pack(carton_id, carton_type_id)` — stamps `wms_pack_cartons.carton_type_id`, recomputes `weight_kg`.

### 3.3 UI

- **`/warehouse-app/crossdock`** — new page listing open opportunities (LPN, product, demand ref, staging bin, "Confirm stage" / "Cancel" buttons). Add to nav under Operations.
- **`/warehouse-app/cartons`** — new page for `wms_carton_types` CRUD under Master. Add to nav.
- `PackStation.tsx` — extend the "add carton" flow to call `suggest_carton` and pre-select the suggestion (operator can override from dropdown).

### 3.4 Guard `src/test/architecture/wms-phase12.test.ts`

Blocks direct writes to `wms_crossdock_opportunities`; restricts `wms_carton_types` writes to the CartonTypes page; asserts every new RPC is called from exactly the pages we ship; asserts nav + routes wire `/crossdock` + `/cartons`; asserts `wms_pack_cartons.carton_type_id` is set only via `assign_carton_to_pack`.

### 3.5 ADR `docs/adr/0083-wms-crossdock-cartonization.md`

Charter: cross-dock is a putaway *substitution* (not a new movement type — still `stock_movements`, still Inventory-owned); cartonization is pack-time optimisation and never blocks a pack when dims are missing.

### 3.6 Definition of done

- Migration applied, types regenerated.
- Both new pages functional; PackStation shows suggested carton.
- Guard test green.
- ADR 0083 committed.
- `.lovable/plan.md` updated: Phase 12 → §2 (shipped), Phase 13 promoted to START HERE NEXT.

## Out of scope this phase

- Multi-carton splits (one order → many cartons) beyond current PackStation behaviour.
- Truck cube-out optimisation (that lives in Phase 5 / dispatch — separate track).
- Cross-dock across warehouses (single-warehouse only for v1).
