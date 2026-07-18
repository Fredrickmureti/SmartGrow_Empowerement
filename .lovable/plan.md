# WMS Handoff — progress log & next step

## Phase 14 — E2E harness rollout

### Landed
- **14a** — Playwright config (`wms` + `wm`), auth/seed support helpers, all 6 desktop + 1 mobile spec skeletons, architecture guard (`src/test/architecture/wms-phase14.test.ts`), docs.
- **14a.1** — RPC contract reconciliation. Added 6 wrapper RPCs (`assign_wms_task`, `claim_pick_task`, `cancel_pick_wave`, `record_goods_receipt_line`, `record_count_scan`, `approve_count_variance`), all `SECURITY DEFINER`, business-scoped, outbox-emitting. Guard `SPECS` reconciled against `pg_proc` (real names: `complete_goods_receipt_atomic`, `suggest_putaway_locations`, `create_pick_wave`, `create_count_session`, `post_count_session`).
- **14b — receive** — `wms_e2e_ensure_seed()` idempotent fixture (warehouse + 3 locations + 2 products + vendor + PO, scoped to caller's active business). `e2e/support/seed.ts` calls it via authed REST. `e2e/wms/receive.spec.ts` unskipped: draft GRN → `record_goods_receipt_line` → `complete_goods_receipt_atomic` → asserts `stock_movements` row of type `receipt`.
- **14c — putaway** — `e2e/wms/putaway.spec.ts` unskipped: receive arc → `receive_goods_to_wms` → `assign_wms_task` → `complete_putaway_task`. Falls back to pinning destination to `E2E_STOCK` when suggestion returns null. Asserts task=`done`, LPN moved, `stock_quants` at destination.
- **14d — wave** — `e2e/wms/wave.spec.ts` unskipped: seed → top-up stock → ad-hoc SO → `create_pick_wave` → `release_pick_wave` → `cancel_pick_wave`. Verifies draft→released→cancelled, ≥1 pick task with `source_location_id`, zero orphan open tasks after cancel, second cancel is `noop`, rebuild produces a fresh wave.
- **14e — pick-pack-dispatch** — `e2e/wms/pick-pack-dispatch.spec.ts` unskipped: extends 14d wave arc through `claim_pick_task` → `complete_pick_task` (per task) → `open_pack_carton` → `assign_line_to_carton` → `seal_pack_carton` → `complete_pack_task` → ad-hoc shipping dock → `open_loading_manifest` → `load_carton_onto_manifest` → `close_loading_manifest` → `dispatch_loading_manifest`. Asserts manifest=`dispatched`, LPN=`shipped`, and outbox terminals `warehouse.carton.shipped` + `warehouse.manifest.dispatched` land exactly once.

### Pending sub-phases
- **14f — qc** — unskip `e2e/wms/qc.spec.ts`. Drive `open_qc_inspection` → `accept_qc_inspection` on one lot and `reject_qc_inspection` on another (asserting quarantine move + `stock_movements`), plus `cancel_qc_inspection` on a third to prove idempotency. Add QC hold reason to seed only if the existing catalogue is empty for the caller's business.
- **14g — count** — unskip `e2e/wms/count.spec.ts`. `create_count_session` on `E2E_STOCK` → `record_count_scan` (matched + variance) → `approve_count_variance` on the variance line → `post_count_session`. Assert `stock_quants` reconciled and a variance adjustment `stock_movements` row exists.
- **14h — mobile offline drain** — unskip `e2e/wm/offline-drain.spec.ts`. Simulate an offline task queue in `localStorage`, restore online, drain via existing sync worker, assert wms_tasks moved and outbox emitted. Requires no schema work.
- **14i — guard hardening** — extend `wms-phase14.test.ts` to (a) refuse any `describe.skip` in `e2e/`, and (b) load a `supabase/tests/wms/rpc-snapshot.json` regenerated from `pg_proc` so the guard fails when the DB drifts from the spec headers.

### Next up for the incoming agent
Pick **14f (QC)**. Before writing the spec:
1. `rg -n "open_qc_inspection|accept_qc_inspection|reject_qc_inspection|cancel_qc_inspection" supabase/migrations/*.sql` and read the signatures — some may still be missing and need thin wrapper RPCs (mirror the 14a.1 approach: `SECURITY DEFINER`, business-scoped, outbox emit).
2. Confirm `wms_qc_hold_reasons` has at least one row for the seeded business; extend `wms_e2e_ensure_seed()` if not — keep it idempotent.
3. Model the fixture on `pick-pack-dispatch.spec.ts` (self-contained receive → putaway to get a lot at `E2E_STOCK`, then open QC on it).
4. Only after 14f green, proceed to 14g → 14h → 14i in order.

## Post-Phase-14 roadmap (unchanged)
- **15** Warehouse Master polish (business rules audit).
- **16** Layout designer (bins/aisles/zones editor).
- **17** Operations dashboard + KPIs.
- **18** Task engine (assignment strategies, SLAs).
- **19** Location intelligence (slotting, ABC).
- **20** Cross-dock + returns.
- **21** Security & RLS re-audit across all new RPCs.
- **22** Enterprise ERP integration surface (event contracts, webhooks).

## Standing rules for this stream
- All new RPCs: `SECURITY DEFINER`, `SET search_path = public`, business-access gated, outbox-emitting with stable idempotency keys (`wms.<entity>:<id>:<state>`).
- Seed extensions must remain idempotent and scoped to the caller's active business — never insert org-wide singletons.
- Guard is authoritative — every new spec header must name the exact `pg_proc` RPC strings it exercises.
- Never mark a phase "done" without unskipping the spec and asserting real read-back state (outbox rows, table state), not just RPC return values.
