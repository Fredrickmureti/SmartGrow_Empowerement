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

Verification run at the end of Phase 4: `no-direct-stock-aggregate-writes`,
`stock-movement-scope`, `stock-event-fabric-and-landed-cost`, `wms-phase3`,
`wms-phase4b`, `wms-no-direct-state-writes`, `wms-task-mutators-optimistic-lock`
— 35/35 passing; `tsgo -p tsconfig.app.json` clean.

## Currently active phase

**Phase 5 — event-driven integration (not started).** Prove every physical
transition reaches `business_event_outbox` with the ADR 0101 idempotency key
`wms.{aggregate}:{id}:{transition}`, that no consumer depends on a client-emitted
event, and that the topic catalog in SQL matches
`src/features/warehouse/events/topics.ts`. Note the two new emissions introduced
in Phases 3–4 (`wms_split_putaway_task`'s child task, its movement pair) currently
have **no explicit outbox emit** of their own — confirm the task/LPN emit triggers
cover them or add the emit.

## Pending after Phase 5

**Phase 6 — handling unit vs product packaging separation.** Verify
`wms_license_plates` models a physical container only, and never re-encodes the
reusable `product_packaging` definition (the Phase 4 defect was a symptom of this
confusion — check `wms_lpn_*` and the LPN UI for other packaging shadowing).

**Phase 7 — costing and valuation seam.** Landed cost, quarantine and damage
dispositions must route to canonical costing functions; no warehouse-local
valuation.

Out of scope this wave: Yard, Workforce beyond enterprise-identity consumption,
3PL billing.

## Instructions for the next agent

1. **Verify before extending.** Re-derive Phases 3 and 4 from the live database
   rather than trusting this document:
   - `wms_split_putaway_task` / `wms_reassign_putaway_task` signatures include a
     mandatory `p_row_version`, no un-versioned overload survives, bodies contain
     `FOR UPDATE`, the `wms_task_stale` raise and the `row_version + 1` bump.
   - `wms_split_putaway_task` resolves quants by `lpn_id`, never `package_id`, and
     posts the `wms_lpn`-tagged movement pair.
   - `_maintain_stock_quants` still short-circuits on `reference_type = 'wms_lpn'`
     (if that ever changes, every plate operation double-counts).
   - `select count(*) from stock_quants q join wms_license_plates l on l.id = q.package_id`
     returns 0, and `trg_stock_quants_package_id_is_packaging` exists.
   - Run the guard suites listed above plus `tsgo -p tsconfig.app.json`. The wider
     `src/test/architecture` run has **pre-existing, unrelated** failures (product
     identifier seam, pdf preview iframe, `pos_hardware_configs`, employee
     lifecycle) — do not attribute those to this wave and do not fix them here.
2. **Then resume at Phase 5**, in the order written above. Do not jump to Phase 6
   or 7, and do not open unrelated areas (Yard, 3PL billing, POS).
3. Every phase lands as a coherent whole: server RPC + caller wiring + a guard
   (pgTAP for server invariants, `src/test/architecture/*` for client wiring), then
   this plan updated in the same turn.
