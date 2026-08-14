# WMS Product & Inventory Consumer Audit — live status

## Verified previously (this pass, independently re-checked)
- **Phase 1 — server-authoritative UoM conversion:** CONFIRMED (`wms_to_base_qty`; capture RPCs take entered qty + packaging; guard 8/8).
- **Phase 2.4 — unit truth on renders:** CONFIRMED (`warehouseQty.tsx` delegates to `@/lib/inventory/formatQty`; guard 3/3).
- **Task FSM + leases:** CONFIRMED — every `wms_transition_*` takes an expected version; `wms_claim_next_task` uses `FOR UPDATE SKIP LOCKED`; `wms_task_reap_expired` runs on a real per-minute `pg_cron` job (`wms-task-lease-reaper`); task/LPN outbox emits happen via `trg_wms_tasks_emit` / `trg_wms_lpn_emit`.
- **Guard on direct task-state writes:** already existed (`wms-no-direct-state-writes.test.ts`) — the old plan listed it as pending.

## Phase 3 — task-concurrency holes: COMPLETE
Defect found and fixed: `wms_split_putaway_task` and `wms_reassign_putaway_task`
were the only `wms_tasks` mutators with **no expected version** and a plain
`SELECT ... INTO` (no row lock), so two supervisors could split the same task
concurrently, each validating against the same stale `quantity`.

Shipped:
1. Migration — both RPCs now take a mandatory `p_row_version`, take `FOR UPDATE`
   on the task, raise `wms_task_stale` (`40001`) on mismatch, bump `row_version`,
   and return the new version. The old un-versioned overloads were dropped, so a
   stale client cannot keep calling the unguarded path.
2. Callers — `PutawayTaskActions` sends `p_row_version: task.row_version` on both
   the direct RPC and the offline-queued split; `PutawayQueue` and
   `MobilePutaway` (which now selects `row_version`) feed it in. Stale errors map
   to "Someone else just updated this task."
3. Guards — `src/test/architecture/wms-task-mutators-optimistic-lock.test.ts`
   (9/9) pins the signatures in the generated types plus the caller wiring;
   `supabase/tests/wms_task_mutators_optimistic_lock_test.sql` pins `FOR UPDATE`,
   the stale check, the version bump and the absence of legacy overloads.

Verification: new guard 9/9, `wms-no-direct-state-writes` 5/5,
`wms-no-direct-domain-rpc` + `wms-guard-parity` green, `tsgo -p tsconfig.app.json` clean.

## Phase 4 — inventory boundary enforcement (next)
Client side is already clean. Audit the **server** side: read every `wms_*`
function body that touches stock and confirm it routes through the sanctioned
ledger primitives rather than writing `stock_movements` / `stock_quants` /
`cost_layers` inline. Note: `wms_split_putaway_task` currently writes
`stock_quants` directly (moves the split portion between plates) — decide
whether that is a sanctioned quant relocation or must route through a ledger
primitive, and pin the answer with pgTAP.

## Phase 5 — event-driven integration
Confirm each lifecycle transition reaches `business_event_outbox` with an
ADR 0101 idempotency key (`wms.{aggregate}:{id}:{transition}`) and that no
consumer relies on a client-emitted event.

## Phase 6 — handling unit vs product packaging separation
Verify `wms_license_plates` models a physical container and does not re-encode
the reusable `product_packaging` definition.

Out of scope this wave: Yard, Workforce beyond enterprise-identity consumption, 3PL billing.
