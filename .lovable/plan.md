
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

---

# Handoff log — where the next agent picks up

_Last updated at end of Phase 2 UI wiring._

## Phase 0 — Scaffolding — ✅ SHIPPED
- `warehouse` app registered in `src/lib/apps/registry.ts`, mounted at `/warehouse-app/*` in `src/App.tsx`.
- `WarehouseLayout`, `WarehouseDashboard`, `WarehouseLayoutPage` functional. `stock_locations` extended with `structure_level`, `barcode`, `pick_sequence`, etc.
- ADR 0079 (Inventory vs Warehouse split) authored.

## Phase 1 — LPN + Universal Task Substrate — ✅ SHIPPED
- Migration `wms_phase1_lpn_and_tasks` created `public.wms_license_plates` and `public.wms_tasks` with RLS, indexes, state-transition triggers → outbox.
- RPC `move_lpn(p_lpn_id, p_destination_location_id)` is the ONLY sanctioned way to change `wms_license_plates.current_location_id`.
- UI: `src/pages/warehouse/{LicensePlates,LicensePlateView,OperatorTasks}.tsx`. Routes + nav wired.
- `DomainEventType` extended with `warehouse.task.*` and `warehouse.plate.*`.
- Guard: `src/test/architecture/wms-phase1.test.ts` — green.

## Phase 2 — Receiving → Putaway — ✅ SHIPPED (this session)

### Database (migration `wms_phase2_receiving_putaway`, already run)
- `stock_locations` +`putaway_priority`, `is_receiving_staging`, `is_putaway_target`.
- `wms_tasks` +`metadata jsonb`.
- New `public.wms_putaway_suggestions` (audit of ranked destinations).
- RPCs: `suggest_putaway_locations`, `receive_goods_to_wms`, `complete_putaway_task`.

### Code
- **New** `src/pages/warehouse/ReceiveToWMSDialog.tsx` — picks unstaged `goods_receipts`, resolves staging bin, calls `receive_goods_to_wms`.
- **New** `src/pages/warehouse/PutawayQueue.tsx` — three-column supervisor board (Pending / In-progress / Done today), filter by warehouse, completes via `complete_putaway_task`. Routed at `/warehouse-app/putaway`, nav under Operations.
- **Modified** `src/pages/warehouse/OperatorTasks.tsx` — Complete on `task_type='putaway'` routes through `complete_putaway_task` (never bare UPDATE).
- **Modified** `src/services/events/domainEventBus.ts` — added `warehouse.receipt.staged`, `warehouse.putaway.suggested`, `warehouse.putaway.completed`.
- **Modified** `src/apps/warehouse/{nav.ts,routes.tsx}` — Putaway route + nav entry.

### Guards
- `src/test/architecture/wms-phase2.test.ts` — 4 tests, all green:
  1. No client code inserts putaway tasks directly.
  2. No bare `.update({state:"done"})` on putaway tasks (must call RPC).
  3. PutawayQueue calls `complete_putaway_task`.
  4. ReceiveToWMSDialog calls `receive_goods_to_wms`.
- Full WMS guard suite (`wms-phase1.test.ts` + `wms-phase2.test.ts`): **6/6 passing**.
- `bunx tsgo --noEmit` — clean for all WMS files.

### Debts intentionally deferred out of Phase 2
- No "Receive to WMS" button on `InboundShipmentDetail.tsx` yet — entry point is via PutawayQueue's toolbar (there is no GRN detail page to hang it off cleanly). If desired, add a button on the ASN detail once its goods-receipt link is surfaced.
- Suggestions panel on `LicensePlateView.tsx` (showing top-3 candidates while plate is at staging) was scoped in but not built. Table `wms_putaway_suggestions` is populated and ready to render.
- Log-only saga handlers for `warehouse.receipt.staged` / `warehouse.putaway.*` NOT wired — current `BusinessSaga`/`BusinessSagaMount` has no `warehouse.*` handlers at all and the outbox trigger already writes the event. Add when the saga layer needs to react (e.g. to notify the receiver).

## Next up — Phase 3 (recommended pick order)

The vision: close the outbound half of the loop so the WMS drives real fulfillment, not just receiving.

### Phase 3 — Picking (Sales Order → Pick tasks → Pack)
**Why now:** we have LPNs, tasks, and a working RPC pattern. Outbound picking mirrors putaway in reverse and reuses every substrate we just built. Delivering it validates the abstractions before they ossify.

Concrete slice:
- Migration `wms_phase3_picking`:
  - `wms_pick_waves` (id, business_id, warehouse_id, state, released_at, released_by).
  - `wms_tasks.task_type` gains `pick`, `pack`, `stage_out` (enum already permits — verify).
  - RPC `release_wave_for_sales_orders(p_wave_id, p_sales_order_ids[])` — atomically reserves stock via `stock_reservations`, splits pick tasks by bin/path, sequences by `pick_sequence`.
  - RPC `complete_pick_task(p_task_id, p_lpn_id?)` — decrements source quant, tags LPN as "pick cart", flips to `packing_staged`.
- UI: `WavePlanner` (bundle SOs → wave), `PickList` (mobile-first task cards ordered by `pick_sequence`), `PackStation` (pack cart → shipping LPN).
- Events: `warehouse.wave.released`, `warehouse.pick.completed`, `warehouse.pack.completed`.
- Guards: pick tasks only via `release_wave_for_sales_orders`; completion only via `complete_pick_task`; wave state machine enforced.

### Phase 4 — Directed movement + cycle counting
- Scanner-driven confirm (reuse `hardware_command_queue`).
- `physical_counts` already exists — wire cycle-count tasks (`task_type='count'`) into the operator queue with `blind_count` support and variance → adjustment via a new `apply_count_variance` RPC.

### Phase 5 — Putaway rule engine + constraints
- `wms_putaway_rules` (versioned, per-warehouse) replacing the hardcoded ranking inside `suggest_putaway_locations`.
- Constraints: weight/volume caps on bins, mixed-lot policies, temperature zones.

### Phase 6 — Dock scheduling + appointments
- `wms_dock_doors`, `wms_appointments`, tie inbound shipments to time slots. Only after picking/putaway are stable.

## How to verify this handoff in one command
```
bunx vitest run src/test/architecture/wms-phase1.test.ts src/test/architecture/wms-phase2.test.ts
# expected: 6 passed
```
Then hit `/warehouse-app/putaway`, click **Receive to WMS**, pick any recent goods receipt + staging bin, confirm N LPNs and N putaway tasks appear in the Pending column. Complete one → LPN's `current_location_id` moves to the destination bin and `business_event_outbox` gains a `warehouse.putaway.completed` row.
