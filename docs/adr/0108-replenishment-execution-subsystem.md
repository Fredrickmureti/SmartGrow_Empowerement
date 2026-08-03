# ADR 0108 — Replenishment as a warehouse execution subsystem

Status: Accepted (2026-08-03)
Depends on: ADR 0079 (Inventory vs. WMS boundary), ADR 0101 (WMS domain, FSM &
event catalog), ADR 0025 (lot-aware quants and FEFO).

## Context

Replenishment shipped as a flat rule table plus a "Generate tasks" button. The
audit found five structural defects:

1. Completing a `replenish` task changed a state column only — no
   `stock_movements`, no quant change. The subsystem was decorative.
2. Two competing rule models (`wms_replenishment_rules`, `wms_replen_rules`)
   plus an unrelated procurement reordering engine sharing the name.
3. The rule model was flat: one row per (warehouse, product, pick face). No
   zone, category, velocity or time-bounded rules.
4. Decisions ignored authoritative demand — open pick waves, blocked or expired
   stock, FEFO and lot were all invisible to the generator.
5. No scan intents, no `warehouse.replen.*` topics, no realtime; the supervisor
   page polled every 15 seconds.

## Decision

### 1. Plan and execution are separate aggregates

`wms_replen_orders` is the *demand* aggregate — what needs refilling, why, from
which rule, with which computed quantity and a decision trace. `wms_tasks`
stays the *work* aggregate. A supervisor can approve, re-prioritise or cancel a
plan before any operator sees work.

Order FSM: `planned → approved → dispatched → in_progress → completed | short |
cancelled`, written only by `wms_transition_replen_order` with `row_version`
optimistic locking. Direct `UPDATE ... SET state` is forbidden (ADR 0101 §1).

### 2. One hierarchical rule aggregate

`wms_replen_rules` is dropped. `wms_replenishment_rules` gains `scope`
(`warehouse | zone | category | product | pick_face`), `strategy`
(`min_max | demand_driven | topoff | manual`), `target_qty`, `zone_location_id`,
`category_id`, `velocity_class`, `is_emergency`, `auto_dispatch`,
`effective_from/to` and `row_version`.

Precedence, resolved by `wms_effective_replen_rule` and mirrored exactly by the
TypeScript reference engine: emergency first, then
`pick_face > product > category > zone > warehouse`, then lowest `priority`.

### 3. Demand-aware planning

`plan_replenishment(p_warehouse_id, p_mode)` replaces
`generate_replenishment_tasks`. It computes the projected pick-face position
(on-hand − wave allocation − blocked/expired + in-flight replenishment),
rounds to the pack multiple, clamps to source availability, chooses a source
FEFO-first, and records a decision trace on the order (`reason_code`, inputs,
chosen source, rejected candidates). It is idempotent while an order is open
and runs in `plan` or `plan_and_dispatch` mode; auto-dispatch is a rule-level
setting.

`src/lib/warehouse/replenishment/engine.ts` is the pure TypeScript mirror of
this logic, unit-tested, and is the shared vocabulary for the UI's health
tiering.

### 4. Execution moves stock

`complete_replenish_task(p_task_id, p_moved_qty, p_source_scan,
p_destination_scan, p_lot_number)` validates the scans against the task's
source and destination, writes the movement through the sanctioned inventory
path, releases the reservation, closes the order, and raises a `short_pick`
`wms_exceptions` row when less than requested was moved. `ReplenishCompleteDialog`
is the only UI path that closes a replenishment task.

Scan intents `replen.source_location`, `replen.lpn`, `replen.item`,
`replen.destination` are registered in `wmsScanIntent.ts` — pages request an
intent, never a device.

### 5. Event fabric and realtime

Topics `warehouse.replen.planned | approved | dispatched | in_progress |
completed | short | cancelled` are emitted through `business_event_outbox`
with idempotency key `wms.replen_order:<id>:<state>`, registered in
`wms_events_catalog`, `src/features/warehouse/events/topics.ts` and
`WMS_MODULE_OWNERSHIP.md`. `wms_replen_orders` and `wms_replenishment_rules`
join the `supabase_realtime` publication and `useWmsRealtimeSync`; the 15s poll
is removed.

### 6. Control centre

The page is composition only: KPI strip, live order queue with bulk
approve/dispatch/cancel, pick-face health board, decision-trace drawer and the
hierarchical rule workbench, all under
`src/features/warehouse/replenishment/*`.

## Boundary

Procurement replenishment (`src/lib/replenishment/engine.ts`,
`replenishment_logs`, the `/replenishment` app route) solves supplier
reordering and is explicitly **not** this subsystem. Warehouse replenishment
refills a pick face from reserve stock inside one warehouse and never creates a
purchase order.

## Consequences

- Completing a replenishment now changes inventory; the pick face actually
  gains stock and the GL sees the movement.
- Every order is explainable — the decision trace names the rule, the inputs
  and the rejected sources.
- Adding a new replenishment behaviour means adding a rule scope or strategy,
  not a new table or a new page-level code path.
