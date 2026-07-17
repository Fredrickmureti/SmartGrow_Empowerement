# WMS execution log

## Done

- **Phase 0–3** — locations extensions, LPN + tasks substrate, receiving/putaway, wave/pick/pack foundations. Arch tests `wms-phase1/2/3.test.ts` green.
- **Phase 4a** — scan-first `PickList`.
- **Phase 4b** — multi-carton packing. Migration `wms_phase4b_multicarton`; tables `wms_pack_cartons`; RPCs `open_pack_carton`, `assign_line_to_carton`, `seal_pack_carton`, rewritten `complete_pack_task` (per-SO). Events `warehouse.carton.opened|sealed`. UI: rewritten `PackStation.tsx`. Guard `wms-phase4b.test.ts` green.
- **Phase 4c** — cycle counting. Migration `wms_phase4c_cycle_count`; tables `wms_count_sessions`, `wms_count_lines`; RPCs `create_count_session`, `record_count`, `post_count_session` (routes variances through `apply_or_request_stock_adjustment` — WMS never edits `stock_quants`). Events `warehouse.count.opened|recorded|posted`. UI: `CycleCounts.tsx`, `CycleCountPlanner.tsx`, `CountSession.tsx`, `CountReview.tsx`; nav entry `Operations → Cycle counts`. Guard `wms-phase4c.test.ts` green.

Verification: `bunx vitest run src/test/architecture/wms-phase*.test.ts` green; `bunx tsgo --noEmit` clean.

## Next — Phase 5: Loading & dispatch

Objective: turn sealed cartons into loaded shipments against a scheduled dock/appointment.

**Migration** `wms_phase5_loading`:
- `warehouse_docks(id, warehouse_id, code, dock_type[receiving|shipping|both], is_active, ...)`.
- `wms_loading_manifests(id, warehouse_id, dock_id, carrier_id nullable, state[draft|loading|closed|dispatched|cancelled], planned_departure_at, closed_at, dispatched_at, ...)`.
- `wms_manifest_cartons(manifest_id, carton_id, loaded_at, loaded_by, sequence)`.
- FK `wms_pack_cartons.manifest_id uuid null`. Grants + RLS scoped by business.

**RPCs**:
- `open_loading_manifest(p_dock_id, p_carrier_id?)` — emits `warehouse.manifest.opened`.
- `load_carton_onto_manifest(p_manifest_id, p_carton_id)` — validates sealed + same warehouse.
- `close_loading_manifest(p_manifest_id)` — transitions to `closed`; emits `warehouse.manifest.closed`.
- `dispatch_loading_manifest(p_manifest_id, p_departure_at?)` — flips carton LPNs to `shipped`; emits `warehouse.manifest.dispatched` (+ per-carton `warehouse.carton.shipped`).

**Events**: register log-only handlers for `warehouse.manifest.opened|closed|dispatched` and `warehouse.carton.shipped`.

**UI** (all under `/warehouse-app/dispatch/*`):
- `LoadingManifests.tsx` — index.
- `LoadingManifestPlanner.tsx` — pick dock + carrier, open manifest.
- `LoadingBay.tsx` — scan-first: scan carton → load onto active manifest; close/dispatch buttons.
- Nav: add `Operations → Dispatch`.

**Guard** `wms-phase5.test.ts`:
- No client-side `wms_loading_manifests` or `wms_manifest_cartons` insert/update — only via RPCs.
- No bare update of `wms_pack_cartons.manifest_id` from a page.
- Dispatch pages must call the sanctioned RPCs.

## Boundary discipline (unchanged, non-negotiable)

- Inventory canonical. WMS never writes `stock_quants` / `warehouse_stock` directly — always via the inventory RPCs.
- Every RPC: `SET LOCAL search_path = public`, single txn, outbox row wrapped in `BEGIN … RAISE WARNING`.
- Every `warehouse.*` event has a handler in `BusinessSagaMount` (Phase 2 arch guard enforces this).

## Out of scope until called for

- Rule-based putaway strategies beyond current suggestions.
- Dock scheduling / appointments (was Phase 6 in prior draft — split from dispatch).
- Carrier rate shopping / labels / EDI.
- QC inspection lifecycle.
- Operator productivity dashboards.
