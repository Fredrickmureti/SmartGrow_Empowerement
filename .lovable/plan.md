## Verification of the prior handoff

Independently checked plan.md against the codebase:

- Phase 0–3 (locations extensions, LPN + tasks, receiving/putaway, wave/pick/pack) — files present: `LicensePlates.tsx`, `OperatorTasks.tsx`, `PutawayQueue.tsx`, `ReceiveToWMSDialog.tsx`, `WavePlanner.tsx`, `PickList.tsx`, `PackStation.tsx`, `LicensePlateView.tsx`, `WarehouseLayoutPage.tsx`.
- Arch tests present: `wms-phase1/2/3.test.ts`.
- Phase 4a (scan-first `PickList`) — present in `PickList.tsx`.
- Migrations are managed via the migration tool (not in `supabase/migrations/`), consistent with the DB tables listed (`wms_license_plates`, `wms_tasks`, `wms_pick_waves`, `wms_pick_wave_lines`, `wms_putaway_suggestions`).

Verdict: handoff is truthful. Resume at Phase 4b, then 4c. Before touching anything, run the verification checklist (Phase 1/2/3 arch tests + `tsgo`) to confirm the substrate is green.

## Phase 4b — Multi-carton packing

Replace the current wave-level LPN in `complete_pack_task` with per-SO, per-carton shipment LPNs.

**Migration** `wms_phase4b_multicarton` (via migration tool):
- `wms_pack_cartons(id, wave_id, sales_order_id, shipment_lpn_id, weight_kg, length_cm, width_cm, height_cm, sealed_at, sealed_by, org_id, created_at/by, updated_at)`. RLS scoped by business; `GRANT SELECT,INSERT,UPDATE,DELETE ON ... TO authenticated`, `GRANT ALL ... TO service_role`.
- `wms_pick_wave_lines.packed_carton_id uuid null references wms_pack_cartons(id)`.
- On wave flip to `picked`, backfill: emit one `pack` task per SO (not per wave) — patch `complete_pick_task` accordingly.

**RPCs** (all `SET LOCAL search_path = public`, single txn, outbox emission with `RAISE WARNING` on failure per Phase 1–3 pattern):
- `open_pack_carton(p_wave_id, p_sales_order_id)` — mints shipment LPN, returns carton id. Emits `warehouse.carton.opened`.
- `assign_line_to_carton(p_carton_id, p_wave_line_id, p_qty)` — validates same-SO, stamps `packed_carton_id`.
- `seal_pack_carton(p_carton_id, p_weight_kg, p_dims jsonb)` — stamps `sealed_at/by`. Emits `warehouse.carton.sealed`.
- Rewrite `complete_pack_task`: done only when every wave line for the SO has a `packed_carton_id` AND every carton for that SO is sealed. Wave `packed` derives from all pack tasks done. Emits `warehouse.pack.completed` per SO.

**Events**: add `warehouse.carton.opened`, `warehouse.carton.sealed` to `DomainEventType` + log-only handlers in `BusinessSagaMount`. Keep `warehouse.pack.completed` (now per-SO).

**UI** — rework `src/pages/warehouse/PackStation.tsx`: one panel per open SO in the wave; "Open new carton" spawns a carton row; assign picked lines to the active carton (drag or click-to-add); seal dialog captures weight + LxWxH.

**Guard** `src/test/architecture/wms-phase4b.test.ts`:
- No client-side `wms_pack_cartons` insert.
- No bare client-side `sealed_at` UPDATE.
- PackStation must call the sanctioned RPCs.

## Phase 4c — Cycle counting

Introduces `warehouse.count.*` and routes stock changes through the existing inventory adjustment RPC (never a bare `stock_quants` UPDATE).

**Migration** `wms_phase4c_cycle_count`:
- `wms_count_sessions(id, warehouse_id, state[draft|counting|review|posted|cancelled], strategy[abc|random|targeted], posted_at, posted_by, org_id, ...)`.
- `wms_count_lines(session_id, location_id, product_id, lot_number, system_qty, counted_qty, variance_qty, note, counted_by, counted_at)`.
- RLS + grants (`authenticated` CRUD, `service_role` ALL).

**RPCs**:
- `create_count_session(p_warehouse_id, p_strategy, p_location_ids uuid[])` — snapshots `system_qty` from `stock_quants` into lines. Emits `warehouse.count.opened`.
- `record_count(p_line_id, p_counted_qty, p_note?)` — updates counted + variance. Emits `warehouse.count.recorded`.
- `post_count_session(p_session_id)` — for each non-zero variance, post via the existing inventory adjustment RPC (do NOT hand-edit `stock_quants`); transition session to `posted`; emit `warehouse.count.posted`.

**Events**: register log-only handlers for `warehouse.count.opened|recorded|posted`.

**UI**:
- `CycleCountPlanner.tsx` — create session (warehouse + strategy + location picker).
- `CountSession.tsx` — scan-first: reuse `BarcodeInputField` from Phase 4a. Scan bin → expected products → scan product + counted qty; variance highlighted.
- `CountReview.tsx` — supervisor review + post.
- Nav: add `Operations → Cycle counts`.

**Guard** `src/test/architecture/wms-phase4c.test.ts`:
- No direct `stock_quants` UPDATE anywhere in `src/pages/warehouse/**`.
- Sessions/lines mutated only via the sanctioned RPCs.

## Boundary discipline (non-negotiable)

- Inventory remains canonical. Cycle count adjustments post through the existing inventory adjustment RPC. WMS never writes `stock_quants` or `warehouse_stock` directly.
- Every RPC: `SET LOCAL search_path = public`, single txn, outbox row with `RAISE WARNING` on failure (never fail the physical action).
- Every new `warehouse.*` event has a handler in `BusinessSagaMount` (arch guard from Phase 2 enforces this).

## Explicitly out of scope (later phases)

- Putaway rule engine + constraints (Phase 5).
- Dock scheduling / appointments (Phase 6).
- Carrier rate shopping, manifests, load planning, `stage_out` task type (Phase 7).
- Fine-grained wave lifecycle events (`.created`, `.picked`, `.closed`) — add when a saga needs them.

## Success criteria

1. Wave with 2 SOs: open 1+ cartons per SO, assign picked lines, seal → `complete_pack_task` succeeds per SO; wave flips to `packed` only after all SOs sealed.
2. Cycle-count a bin with a variance → `post_count_session` writes exactly one inventory adjustment per non-zero line; `stock_quants` reflect it; no direct `stock_quants` write from WMS code.
3. `bunx vitest run src/test/architecture/wms-phase1..4c` — all green.
4. `bunx tsgo --noEmit` clean.

## Files touched

**New:** migrations `wms_phase4b_multicarton`, `wms_phase4c_cycle_count`; `src/pages/warehouse/{CycleCountPlanner,CountSession,CountReview}.tsx`; `src/test/architecture/wms-phase4b.test.ts`, `wms-phase4c.test.ts`; ADRs `0082-multicarton-packing.md`, `0083-cycle-counting.md`.

**Modified:** `src/pages/warehouse/PackStation.tsx`, `src/apps/warehouse/{nav.ts,routes.tsx}`, `src/services/events/domainEventBus.ts`, `src/contexts/BusinessSagaMount.tsx`, `.lovable/plan.md` handoff log.
