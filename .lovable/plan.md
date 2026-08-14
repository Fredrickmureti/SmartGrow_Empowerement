# WMS Product & Inventory Consumer Audit — authoritative status

Question being answered across this wave: does the Warehouse app act as the
**physical execution layer** on top of the canonical Product and Inventory
foundations, or does it quietly re-model them?

## Fully implemented and verified

**Phase 1 — server-authoritative UoM conversion.** `wms_to_base_qty` reads the
canonical `product_packaging`; capture RPCs take entered qty + packaging id, never
a client-converted base figure. Guard: `wms-server-authoritative-uom.test.ts` (8/8).

**Phase 2.4 — unit truth on every warehouse quantity render.** Warehouse surfaces
delegate to `@/lib/inventory/formatQty`; no hardcoded unit strings. Guard passing.

**Phase 3 — task concurrency and lifecycle authority.** COMPLETE.
- Every `wms_transition_*` takes an expected version; `wms_claim_next_task` uses
  `FOR UPDATE SKIP LOCKED`; `wms_task_reap_expired` runs on the per-minute
  `pg_cron` job `wms-task-lease-reaper` (not a manual button).
- Defect found and fixed: `wms_split_putaway_task` / `wms_reassign_putaway_task`
  were the only `wms_tasks` mutators with no expected version and no row lock, so
  two supervisors could split the same task against the same stale `quantity`.
  Both now take a mandatory `p_row_version`, take `FOR UPDATE`, raise
  `wms_task_stale` (`40001`) on mismatch and bump `row_version`; the un-versioned
  overloads were dropped so a stale client cannot reach the unguarded path.
- Callers thread the rendered version: `PutawayTaskActions` (direct RPC and the
  offline-queued split), `PutawayQueue`, `MobilePutaway` (now selects
  `row_version`). Stale errors surface as "Someone else just updated this task."
- Guards: `src/test/architecture/wms-task-mutators-optimistic-lock.test.ts` (9/9)
  and `supabase/tests/wms_task_mutators_optimistic_lock_test.sql` (11 checks).

**Phase 4 — Inventory ledger boundary.** COMPLETE.
- Server-side audit of every `wms_*` function touching stock. Sanctioned:
  `wms_apply_gr_stock`, `wms_reverse_gr_stock`, `wms_post_receiving_session`,
  `wms_post_return_dispositions` post `stock_movements` and let
  `_maintain_stock_quants` derive balances. The LPN primitives
  (`wms_lpn_move/load/unload/split/merge/dispatch/receive_return`) relocate
  plate-scoped quants explicitly and tag their movements `reference_type='wms_lpn'`,
  which the trigger deliberately skips — audit trail without double-applying.
  No warehouse function writes `cost_layers`, `warehouse_stock*` or `stock_lots`.
- Defect found and fixed: `wms_split_putaway_task` matched and stamped the plate
  through `stock_quants.package_id`, which is a `product_packaging` FK (ADR 0064) —
  corrupting the Product foundation's packaging dimension and guaranteeing it could
  never match plate quants written by the LPN primitives (they use `lpn_id`). It also
  posted no movement for a real bin-to-bin move. It now resolves and writes via
  `lpn_id`, checks available (not gross) quantity, deletes emptied quants, and posts
  paired `transfer_out`/`transfer_in` movements tagged `wms_lpn`. Zero rows were
  affected — the path had never produced a quant.
- New structural safeguard: trigger `trg_stock_quants_package_id_is_packaging`
  rejects any quant whose `package_id` is a license plate
  (`INVENTORY_QUANT_PACKAGE_IS_LPN`).
- Guard: `supabase/tests/wms_inventory_ledger_boundary_test.sql` (12 checks, each
  assertion re-evaluated against the live catalog and true).

**Phase 5 — event-driven integration.** COMPLETE.
- Server audit of every `warehouse.*` topic literal emitted by a public
  function against `wms_events_catalog` and `src/features/warehouse/events/topics.ts`.
- Defects found and fixed:
  1. `create_count_session_as` emitted `warehouse.count.opened` and
     `post_count_session` emitted `warehouse.count.submitted` — both retired
     vocabulary, unregistered in the catalog, undeclared in TS, and **duplicate
     producers** on top of `trg_wms_counts_emit` (which already publishes
     `warehouse.count.counting` on INSERT and `warehouse.count.review` on the
     state change). Both in-body emits removed; the trigger is the single producer.
  2. `_wms_count_trigger_from_event` (event-driven cycle counting) dispatched on
     `warehouse.replenishment.completed` and `warehouse.return.dispositioned` —
     topics no producer emits — so replenishment- and return-triggered counts had
     silently never fired. Now keys off `warehouse.replen.completed` and
     `warehouse.return.dispositions_posted`.
  3. `wms_publish_labour_plan` built non-ADR idempotency keys (`topic:id`); now
     `wms.labour:{warehouse}:{transition}[:date]`.
  4. 13 actively emitted topics had **no catalog row** (appointment.rescheduled,
     exception.acknowledged/assigned/escalated, manifest.tracking_allocated,
     manifest.proof_captured, packaging.* ×6, wave.planned) and the two
     `warehouse.labour.*` topics had no TS constant. All registered in
     `wms_events_catalog`, declared in `WMS_TOPIC`, and documented in
     `docs/architecture/WMS_MODULE_OWNERSHIP.md` (crossdock rows added there too).
- Phases 3–4 emissions confirmed covered: `trg_wms_tasks_emit` is
  `AFTER INSERT OR UPDATE OF state`, so the split-putaway child task is announced;
  the plate relocation is announced by `trg_wms_lpn_moved`. No inline emit needed.
- Guards: `src/test/architecture/wms-event-integration.test.ts` (4/4) and
  `supabase/tests/wms_event_integration_test.sql` (10 checks, each re-evaluated
  against the live catalog and true). Yard topics (`warehouse.yard.*`) are the
  only unregistered emitters left and are an explicit, listed exemption owned by
  the out-of-scope yard wave — any new unregistered topic fails the ratchet.

Verification run at the end of Phase 5: `wms-event-integration`,
`wms-topic-catalog-sync`, `wms-topic-vocabulary`, `wms-outbox-parity`,
`wms-task-mutators-optimistic-lock`, `wms-phase3`, `wms-phase4b`,
`wms-no-direct-state-writes`, `wms-server-authoritative-uom` — 47/47 passing;
`tsgo -p tsconfig.app.json` clean.

## Currently active phase

**Phase 6 — handling unit vs product packaging separation (not started).**
Verify `wms_license_plates` models a physical container only and never
re-encodes the reusable `product_packaging` definition. The Phase 4 defect
(`stock_quants.package_id` stamped with an LPN id) was a symptom of exactly this
confusion, so sweep the sibling paths: every `wms_lpn_*` function, the LPN UI,
`wms_packaging_*` (packaging *materials* — cartons/dunnage consumed at pack
stations — must stay distinct from `product_packaging` UoM definitions), and any
warehouse table column that duplicates a packaging attribute (length/width/
height/weight/qty-per-pack). Land it as: server fix (if any) + caller wiring +
pgTAP structural guard, then update this plan.

## Pending after Phase 6

**Phase 7 — costing and valuation seam.** Landed cost, quarantine and damage
dispositions must route to canonical costing functions; no warehouse-local
valuation.

Out of scope this wave: Yard (including its unregistered `warehouse.yard.*`
topics), Workforce beyond enterprise-identity consumption, 3PL billing.

## Instructions for the next agent

1. **Verify before extending.** Re-derive Phases 3–5 from the live database
   rather than trusting this document:
   - Phase 3/4: `wms_split_putaway_task` / `wms_reassign_putaway_task` take a
     mandatory `p_row_version`, no un-versioned overload survives, bodies contain
     `FOR UPDATE`, the `wms_task_stale` raise and the `row_version + 1` bump; the
     split resolves quants by `lpn_id` (never `package_id`) and posts the
     `wms_lpn`-tagged movement pair; `_maintain_stock_quants` still
     short-circuits on `reference_type = 'wms_lpn'`;
     `select count(*) from stock_quants q join wms_license_plates l on l.id = q.package_id`
     returns 0 and `trg_stock_quants_package_id_is_packaging` exists.
   - Phase 5: run the DO block in `supabase/tests/wms_event_integration_test.sql`
     against the live database — every `warehouse.*` literal emitted by a public
     function must be catalogued (yard exempted), the count RPCs must not touch
     `business_event_outbox`, and `_wms_count_trigger_from_event` must key off the
     live topics.
   - Run the guard suites listed above plus `tsgo -p tsconfig.app.json`. The wider
     `src/test/architecture` run has **pre-existing, unrelated** failures (product
     identifier seam, pdf preview iframe, `pos_hardware_configs`, employee
     lifecycle) — do not attribute those to this wave and do not fix them here.
2. **Then resume at Phase 6**, in the order written above. Do not jump to Phase 7,
   and do not open unrelated areas (Yard, 3PL billing, POS).
3. Every phase lands as a coherent whole: server RPC + caller wiring + a guard
   (pgTAP for server invariants, `src/test/architecture/*` for client wiring), then
   this plan updated in the same turn.

