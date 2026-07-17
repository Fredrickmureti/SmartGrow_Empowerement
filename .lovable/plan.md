# WMS continuation plan

## Status snapshot

**Done (shipped):**

- Phases 0–7: LPNs, tasks, putaway, waves, picking, packing, cycle counts, loading/dispatch, dock appointments, QC logical state machine.
- **Phase 7.1** — QC physical stock effects. `QUARANTINE` provisioning per warehouse, `_wms_ensure_qc_hold` / `_wms_default_putaway` helpers, `_wms_qc_post_move` two-row signed movements. `open_/accept_/reject_qc_inspection` now post `stock_movements`. `reject … return_to_vendor` seeds a `purchase_returns` draft. `emit_qc_event` fixed to correct `business_event_outbox` schema. GRN completion auto-opens QC when `products.requires_qc = true`.
- **Phase 8** — Replenishment & slotting.
  - Table `wms_replenishment_rules` (biz-scoped, RLS).
  - RPC `generate_replenishment_tasks(warehouse)` — evaluates active rules, enqueues `wms_tasks(task_type='replenish')` from source → pick face, respects `pack_multiple`, skips duplicates.
  - View `wms_slotting_velocity_view` — rolling 90-day pick velocity per product per warehouse, A/B/C via `PERCENT_RANK`.
  - UI: `/warehouse-app/replenishment` (rules table + "Generate tasks" + live open-task queue + create-rule dialog + activate toggle) and `/warehouse-app/slotting` (A/B/C dashboard, filters, ranked table).
  - Nav entries under Operations.
  - Guard `wms-phase8.test.ts` — blocks direct `wms_tasks` inserts of `task_type='replenish'`, blocks writes to the velocity view, asserts RPC usage and route/nav wiring. All Phase 7 + Phase 8 guards green.

**Not started:**

- Phase 9 — Yard / trailer management (yard slots, trailer check-in/out, seal capture).
- Phase 10 — Labour management (task standards, operator productivity).
- Phase 11 — 3PL billing (activity-based charges).

## Non-negotiables carried forward

1. Inventory remains the single source of truth for quantity/value. Warehouse only posts through the sanctioned `stock_movements` ledger.
2. `wms_*` tables stay RPC-only for state transitions; the only PostgREST writes we accept are user-authored **master data** (currently: replenishment rules), and they carry business-scoped RLS.
3. Every phase ships an architecture guard.
4. Chronological order: 7.1 → 8 → **9** → 10 → 11. Do not skip.

## Next up — Phase 9 (Yard & Trailer)

Sketch (build next turn):

- `wms_yard_slots(warehouse_id, code, slot_type, status)` — spot inventory for trailers waiting inbound/outbound.
- `wms_trailer_visits(carrier, trailer_ref, driver_ref, seal_in, seal_out, arrived_at, docked_at, departed_at, appointment_id)`.
- RPCs: `check_in_trailer`, `assign_trailer_to_dock`, `depart_trailer` — each emits `warehouse.yard.*`.
- Ties `wms_dock_appointments` → `wms_trailer_visits` so dispatch/receiving KPIs (dwell, on-time) become computable.
- UI: `/warehouse-app/yard` (yard map + arrivals board).

## Explicitly out of scope this pass

- AQL sampling automation, vendor-portal RTV, predictive QC.
- Cost-layer / AVCO changes.
- Cross-dock and cartonization (candidates for Phase 12+ after labour/billing).
