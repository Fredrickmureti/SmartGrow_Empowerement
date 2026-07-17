# WMS execution log

Living handoff document. Every agent updates the **Done**, **In-flight**, and **Next** sections before ending a turn so the next agent can resume without re-deriving state.

## Done (shipped + verified)

- **Phase 0–3** — locations extensions, LPN + tasks substrate, receiving/putaway, wave/pick/pack foundations. Arch tests `wms-phase1/2/3.test.ts` green.
- **Phase 4a** — scan-first `PickList`.
- **Phase 4b** — multi-carton packing.
  - Migration `wms_phase4b_multicarton`; table `wms_pack_cartons`; `wms_pick_wave_lines.carton_id`.
  - RPCs: `open_pack_carton`, `assign_line_to_carton`, `seal_pack_carton`, rewritten `complete_pack_task` (per-SO).
  - Events: `warehouse.carton.opened|sealed` wired in `domainEventBus.ts` + `BusinessSagaMount.tsx`.
  - UI: `src/pages/warehouse/PackStation.tsx` rewritten (per-SO, multi-carton, seal weight/dims).
  - Guard: `src/test/architecture/wms-phase4b.test.ts` green.
- **Phase 4c** — cycle counting.
  - Migration `wms_phase4c_cycle_count`; tables `wms_count_sessions`, `wms_count_lines`.
  - RPCs: `create_count_session` (snapshots `stock_quants`), `record_count`, `post_count_session` (routes variances through `apply_or_request_stock_adjustment` — WMS never edits `stock_quants`).
  - Events: `warehouse.count.opened|recorded|posted`.
  - UI: `CycleCounts.tsx`, `CycleCountPlanner.tsx`, `CountSession.tsx`, `CountReview.tsx`; nav `Operations → Cycle counts`.
  - Guard: `wms-phase4c.test.ts` green.
- **Phase 5** — loading & dispatch.
  - Migration `wms_phase5_loading`; tables `warehouse_docks`, `wms_loading_manifests`, `wms_manifest_cartons`; FK `wms_pack_cartons.manifest_id`.
  - RPCs: `open_loading_manifest`, `load_carton_onto_manifest`, `close_loading_manifest`, `dispatch_loading_manifest` (flips carton LPNs → `shipped`).
  - Events: `warehouse.manifest.opened|closed|dispatched`, `warehouse.carton.shipped`.
  - UI: `LoadingManifests.tsx`, `LoadingManifestPlanner.tsx`, `LoadingBay.tsx` under `/warehouse-app/dispatch/*`; nav `Operations → Dispatch`.
  - Guard: `src/test/architecture/wms-phase5.test.ts` green.

**Verification snapshot at end of Phase 5:**
- `bunx vitest run src/test/architecture/wms-phase*.test.ts` → all green (phases 1, 2, 3, 4b, 4c, 5).
- `bunx tsgo --noEmit` → clean.

## In-flight

_Nothing in-flight. Phase 5 fully landed and verified. Safe to start Phase 6._

## Next — Phase 6: Dock scheduling & appointments

Objective: schedule inbound/outbound dock usage so receiving + dispatch don't collide, and give manifests a real appointment to bind to (today `wms_loading_manifests.planned_departure_at` is a free-text field).

**Migration** `wms_phase6_dock_appointments`:
- `wms_dock_appointments(id, warehouse_id, dock_id, appointment_type[inbound|outbound], carrier_id nullable, reference text, window_start timestamptz, window_end timestamptz, state[scheduled|arrived|in_progress|completed|cancelled|no_show], arrived_at, completed_at, created_by, ...)`.
- FK `wms_loading_manifests.appointment_id uuid null references wms_dock_appointments(id)`.
- FK `wms_receipts.appointment_id uuid null` (mirror on the inbound side — receipts table already exists from Phase 1).
- Exclusion constraint or trigger: no two non-cancelled appointments overlap on the same `dock_id`.
- Grants + RLS scoped by business, same pattern as `wms_loading_manifests`.

**RPCs** (all `SECURITY DEFINER`, `SET LOCAL search_path = public`, outbox wrapped in `BEGIN … RAISE WARNING`):
- `schedule_dock_appointment(p_dock_id, p_type, p_window_start, p_window_end, p_carrier_id?, p_reference?)` → emits `warehouse.appointment.scheduled`. Must reject overlap.
- `mark_appointment_arrived(p_appointment_id)` → emits `warehouse.appointment.arrived`.
- `complete_dock_appointment(p_appointment_id)` → emits `warehouse.appointment.completed`.
- `cancel_dock_appointment(p_appointment_id, p_reason?)` → emits `warehouse.appointment.cancelled`.
- Extend `open_loading_manifest` to accept optional `p_appointment_id` and validate it matches the dock + is `scheduled|arrived`.

**Events**: register log-only handlers in `BusinessSagaMount.tsx` for `warehouse.appointment.scheduled|arrived|completed|cancelled` (Phase 2 arch guard requires it).

**UI** (all under `/warehouse-app/schedule/*`):
- `DockSchedule.tsx` — day/week grid per warehouse, appointments per dock lane.
- `AppointmentPlanner.tsx` — create/edit appointment with dock, window, carrier, type.
- Hook appointment picker into `LoadingManifestPlanner.tsx` (dispatch side) and `Receiving` create flow (inbound side) — the picker is read-only wiring, the mutation still goes through the sanctioned RPCs.
- Nav: add `Operations → Dock schedule` in `src/apps/warehouse/nav.ts`.

**Guard** `src/test/architecture/wms-phase6.test.ts`:
- No client-side insert/update of `wms_dock_appointments` — only via the four RPCs.
- No client-side write of `wms_loading_manifests.appointment_id` or `wms_receipts.appointment_id`.
- Every `warehouse.appointment.*` event has a handler registered in `BusinessSagaMount.tsx`.

### Where to pick up (for the next agent)

1. Read this file. Confirm the **Done** section still matches the codebase (spot-check one RPC via `supabase--read_query` and one UI page via `code--view`).
2. Re-run the verification snapshot commands above. If anything is red, fix that before touching Phase 6.
3. Read `src/pages/warehouse/LoadingManifestPlanner.tsx` and the `wms_receipts` table shape (via `supabase--read_query` on `information_schema`) — Phase 6 has to bolt onto both.
4. Ship the Phase 6 migration first, then RPCs, then events, then UI, then the arch guard. Keep each in its own tool-call batch so failures are attributable.
5. When Phase 6 lands, move its block from **Next** to **Done**, update the verification snapshot, and write the next objective into **Next** (candidate: Phase 7 — QC inspection lifecycle, or Phase 7 — operator productivity dashboards; pick based on user direction).

## Boundary discipline (unchanged, non-negotiable)

- Inventory canonical. WMS never writes `stock_quants` / `warehouse_stock` directly — always via the inventory RPCs (`apply_or_request_stock_adjustment`, `approve_stock_adjustment_atomic`).
- Every RPC: `SET LOCAL search_path = public`, single txn, outbox row wrapped in `BEGIN … RAISE WARNING`.
- Every `warehouse.*` event has a handler in `BusinessSagaMount` (Phase 2 arch guard enforces this).
- Client code never mutates WMS operational tables directly — always via the sanctioned RPCs. Every phase ships an arch guard that enforces this for its new tables.

## Out of scope until called for

- Rule-based putaway strategies beyond current suggestions.
- Carrier rate shopping / labels / EDI.
- Operator productivity dashboards (candidate for a later phase).
- QC inspection lifecycle (candidate for a later phase).
