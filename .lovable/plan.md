
# Phase 2 — Receiving → Putaway

**Goal.** Make the WMS task queue and license-plate substrate earn their keep by seeding *real* work from real goods receipts, without disturbing the inventory ledger. When a receiver posts a `goods_receipt`, the WMS assigns each received line to a staging bin under a fresh LPN and creates a `putaway` task pointing at a suggested destination bin. The operator completes the task from the queue, which physically moves the LPN and records the movement in the outbox.

**Scope discipline.** No rule engine, no wave planning, no dock scheduling — those stay Phases 3+. Phase 2 ships one clean loop end-to-end so every subsequent phase has a real substrate to build on.

## What we build

### 1. Schema additions (`wms_phase2_receiving_putaway`)

- `stock_locations.putaway_priority integer` — higher = try first when suggesting destinations. Default 0.
- `stock_locations.is_receiving_staging boolean` and `is_putaway_target boolean` — explicit flags (the existing `usage` column mixes concerns).
- `wms_tasks.metadata jsonb default '{}'::jsonb` — carry receipt line context (`goods_receipt_item_id`, `expected_lot`, `expected_expiry`) without a table join.
- New table `public.wms_putaway_suggestions` (audit of why a destination was picked) with `task_id`, `location_id`, `rank`, `reason`, `chosen boolean`. Grants + RLS.
- New RPC `suggest_putaway_locations(p_warehouse_id uuid, p_product_id uuid, p_quantity numeric)` — returns ranked candidates using: matching product's `preferred_location_id` if set → same-category open bins → any active `is_putaway_target=true` bin sorted by `putaway_priority desc, pick_sequence asc`. Read-only, stable, security-definer over `stock_locations`.
- New RPC `receive_goods_to_wms(p_goods_receipt_id uuid, p_staging_location_id uuid)` — atomic transaction that, for each line on the receipt:
  1. mints an `wms_license_plates` row (`lpn_type='pallet'` default; overridable in a follow-up),
  2. writes/updates the `stock_quants` row so `package_id = lpn.id` and `location_id = p_staging_location_id`,
  3. inserts a `wms_tasks` row (`task_type='putaway'`, `state='pending'`, `source_location_id=staging`, `destination_location_id=suggest_putaway_locations(...).first`, `product_id`, `lot_number`, `lpn_id`, `quantity`, `metadata={goods_receipt_item_id}`),
  4. records the top 3 suggestions in `wms_putaway_suggestions` with `chosen=true` on the picked one.
  Returns `jsonb` with counts + task ids. Idempotent by `goods_receipt_id` (safe re-run marks additional lines only).
- New RPC `complete_putaway_task(p_task_id uuid)` — validates state ∈ (`assigned`,`in_progress`), calls `move_lpn(lpn_id, destination_location_id)`, transitions task to `done`, sets `completed_at`.

All triggers set `search_path = public` and use `EXCEPTION WHEN OTHERS THEN RAISE WARNING` for outbox writes (ADR 0076).

### 2. UI

- **Receive to WMS action** on `InboundShipmentDetail.tsx` and on the goods receipt view: a dialog that picks a staging bin (default: warehouse's first `is_receiving_staging=true` location) and calls `receive_goods_to_wms`. Success toast links straight to the seeded tasks.
- New page `src/pages/warehouse/PutawayQueue.tsx` — a focused sub-view of Operator Tasks pre-filtered to `task_type=putaway` with three columns (Pending / In Progress / Done today) so a supervisor sees flow at a glance.
- Operator flow: existing `OperatorTasks` page already handles claim/start/complete. We override the **Complete** action for `putaway` tasks to call `complete_putaway_task` RPC instead of a plain UPDATE, so the LPN actually moves.
- On `LicensePlateView` show recent putaway suggestions when the plate is still at a staging bin, so an operator can pick a different destination and the choice is captured.

### 3. Domain events

Append to `DomainEventType`:
- `warehouse.receipt.staged` — one per receive_goods_to_wms invocation
- `warehouse.putaway.suggested` — one per task creation (payload includes ranked candidates)
- `warehouse.putaway.completed` — emitted by `complete_putaway_task`

Wire log-only saga handlers so the outbox pipe is exercised.

### 4. Nav + routes

Add `Operations → Putaway` between `Overview` and `Operator tasks` in `src/apps/warehouse/nav.ts`. Wire `/warehouse-app/putaway` in `apps/warehouse/routes.tsx`. Only after `PutawayQueue.tsx` is functional.

### 5. Architecture guards (`src/test/architecture/wms-phase2.test.ts`)

- No client code calls `.insert(...)` into `wms_tasks` with `task_type: 'putaway'` — must go through `receive_goods_to_wms` RPC. (Ad-hoc `move` tasks stay allowed.)
- Completing a putaway task in UI code must go through `complete_putaway_task` RPC (grep: no `.update({state:'done'})` where the surrounding block mentions `putaway`).
- Every new `warehouse.*` event in `DomainEventType` has a registered handler in `BusinessSagaMount.tsx`.

## Success criteria

1. From a real `goods_receipt` with N lines, "Receive to WMS" creates N LPNs, N pending putaway tasks, and 3N suggestion audit rows in one transaction.
2. Completing a putaway task moves the LPN's `current_location_id` and emits exactly one `warehouse.plate.moved` + one `warehouse.putaway.completed` outbox row.
3. `bunx tsgo --noEmit` clean; `bunx vitest run src/test/architecture/wms-phase2.test.ts` green.
4. Deep-link `/warehouse-app/putaway` renders the three-column board with real data; `/warehouse-app/plates/<id>` shows the plate at its new bin.

## Explicitly out of scope

Putaway *rule engine* (rules table + versioned policies), constraint-based bin selection (weight/volume/mixed-lot), directed put-away with scanner confirm, cross-docking, blind-count reconciliation, receiving appointments. Those are Phase 2.5 / Phase 3.

## Files touched

**New:** `supabase/migrations/<ts>_wms_phase2_receiving_putaway.sql`, `src/pages/warehouse/PutawayQueue.tsx`, `src/pages/warehouse/ReceiveToWMSDialog.tsx`, `src/test/architecture/wms-phase2.test.ts`, `docs/adr/0080-putaway-substrate.md`.

**Modified:** `src/pages/inventory/InboundShipmentDetail.tsx` (Receive-to-WMS button), `src/pages/warehouse/OperatorTasks.tsx` (RPC-aware Complete for putaway), `src/pages/warehouse/LicensePlateView.tsx` (suggestions panel), `src/apps/warehouse/{nav.ts,routes.tsx}`, `src/services/events/domainEventBus.ts`, `src/contexts/BusinessSagaMount.tsx`.
