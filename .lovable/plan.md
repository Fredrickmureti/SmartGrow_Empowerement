# WMS Product & Inventory Consumer Audit — live status

## Verification of the previous engineer's claims (this pass)

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — server-authoritative UoM conversion | CONFIRMED | `wms_to_base_qty` live; capture RPCs take `(entered_qty, packaging_id)`; guard `wms-server-authoritative-uom.test.ts` 8/8 green |
| Phase 2.4 — unit truth on warehouse renders | CONFIRMED | `src/features/warehouse/quantity/warehouseQty.tsx` delegates to `@/lib/inventory/formatQty`; guard `warehouse-qty-display.test.ts` 3/3 green |
| Phase 3 step 3 — guard on direct task state writes | ALREADY DONE (mislabelled pending) | `src/test/architecture/wms-no-direct-state-writes.test.ts` covers `wms_tasks`, `wms_license_plates`, `wms_receiving_sessions`, `wms_return_orders`, `wms_exceptions` |
| Phase 3 step 1 — FSM guarded by state + `row_version` | MOSTLY CONFIRMED | Every `wms_transition_*` takes an expected version; `wms_claim_next_task` uses `FOR UPDATE SKIP LOCKED`; client callers thread `row_version` (OperatorTasks, PutawayQueue, WavePlanner, ReceivingSessions, CrossdockBoard, CountReview, LoadingManifests) |
| Phase 3 step 2 — leases cannot orphan tasks | CONFIRMED (infrastructure) | `wms_task_reap_expired` runs on a real `pg_cron` job `wms-task-lease-reaper` (every minute), not a manual button |
| Task/LPN events reach the outbox | CONFIRMED via triggers | `trg_wms_tasks_emit` / `trg_wms_lpn_emit` emit; transition RPCs need not emit inline |

No completed work needs redoing. The plan's "Phase 3" is largely already satisfied — but verification surfaced two genuine holes that were not in the plan at all.

## Newly discovered defects (this is the work to do)

### D1 — putaway split/reassign bypass optimistic concurrency (real race)
`wms_split_putaway_task(p_task_id, p_quantity, p_location_id, p_reason)` and
`wms_reassign_putaway_task(p_task_id, p_location_id, p_reason)` are the only
`wms_tasks` mutators that take **no expected version** and read the task with a
plain `SELECT * INTO` (no `FOR UPDATE`). Two supervisors splitting the same
100-unit task concurrently each validate `p_quantity` against the same stale
`quantity`, so a task can be split beyond its own quantity and capacity
feasibility is checked against a value that no longer holds.

Fix: add `p_row_version integer` to both, lock the row with `FOR UPDATE`,
reject on version mismatch with the same error shape the other FSM RPCs raise
(`Row version mismatch`), bump `row_version`, and thread the version from the
callers (`PutawayQueue`, putaway feature components) through the existing
`useAggregateTransitions` / `useDomainOperations` seam so the existing
mismatch-to-toast mapping keeps working.

### D2 — the concurrency guarantee is unpinned
No test asserts that *every* `wms_tasks`-mutating RPC takes a version
parameter, so D1 could recur. Add an architecture guard that enumerates the
task-mutating RPC surface and fails on any mutator without an expected-version
parameter, plus a pgTAP structural check mirroring
`supabase/tests/wms_dispatch_relieves_inventory_test.sql`.

## Phase 3 (revised) — close the task-concurrency holes
1. Migration: version-guard + `FOR UPDATE` for `wms_split_putaway_task` and
   `wms_reassign_putaway_task`.
2. Thread `rowVersion` from every client caller through the typed wrapper layer.
3. Guards: architecture test on the task-mutator RPC surface + pgTAP structural pins.
Done when: migration applied, callers typecheck clean, both guards fail on a
deliberate regression.

## Phase 4 — inventory boundary enforcement (next)
Client side is already clean (no direct `stock_quants` / `stock_movements`
writes from warehouse code). Remaining work is the **server** side: read each
`wms_*` function body that touches stock and confirm it routes through the
sanctioned ledger primitives rather than writing `stock_movements` /
`stock_quants` / `cost_layers` inline; pin the result with pgTAP.

## Phase 5 — event-driven integration
Confirm each lifecycle transition reaches `business_event_outbox` with an
idempotency key of the ADR 0101 shape (`wms.{aggregate}:{id}:{transition}`),
and that no consumer relies on a client-emitted event.

## Phase 6 — handling unit vs product packaging separation
Verify `wms_license_plates` models a physical container and does not re-encode
the reusable `product_packaging` definition.

Out of scope this wave: Yard (no Product/Inventory dependency established),
Workforce beyond confirming the enterprise identity is consumed, 3PL billing.

## Technical notes
- Concurrency error surface: `src/features/warehouse/aggregates/useDomainOperations.ts`
  already maps `Row version mismatch` / `row_version` to an operator-safe toast.
- Version-threading seam: `src/features/warehouse/aggregates/useAggregateTransitions.ts`
  (`p_row_version`).
- RPC ban/wrapper parity is enforced by `wms-no-direct-domain-rpc.test.ts` +
  `wms-guard-parity.test.ts` — new RPC signatures must keep exactly one
  wrapper-layer call site.
