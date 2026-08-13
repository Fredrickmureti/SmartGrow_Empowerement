# Replenishment as a Warehouse Execution Subsystem

## Audit findings (verified in code)

The current Replenishment surface is a rules table plus a "Generate tasks" button. Against enterprise WMS expectations (EWM, Manhattan, Blue Yonder, Oracle WMS Cloud) it has five structural defects, all confirmed by reading the implementation:

1. **Replenishment does not move inventory.** `generate_replenishment_tasks` (migration `20260717221821`) inserts a `replenish` row into `wms_tasks`, and `OperatorTasks.tsx` completes it with a plain `wms_transition_task(... 'completed')`. There is a `complete_putaway_task`, `complete_pick_task`, `complete_pack_task` — there is **no** `complete_replenish_task`. Completing a replenishment today changes a state column and nothing else: the pick face never gains stock, no `stock_movements` row is written, no cost or quant is touched. The subsystem is decorative.

2. **Two competing rule models.** `wms_replenishment_rules` (min/max/pack_multiple, business-writable, used by the page) and `wms_replen_rules` (min/target/max, source zone, admin-only, declared in ADR 0101 and never read anywhere). Duplicated domain state with divergent RLS. On top of that, an unrelated *procurement* replenishment exists (`src/lib/replenishment/engine.ts`, `replenishment_logs`, `/replenishment` in the app registry) which shares the name but solves reordering from suppliers, not pick-face refill.

3. **The rule model is flat, not hierarchical.** One row per (warehouse, product, pick location). No zone rules, no category/velocity rules, no priority overrides, no time-bounded (seasonal/campaign/emergency) rules. Every enterprise system resolves an *effective* rule from a hierarchy; here every pick face must be enumerated by hand.

4. **Decisions ignore authoritative demand.** The generator compares `stock_quants` on-hand net of reservations against `min_qty`. It never consults open pick waves, allocated demand, blocked/quarantined/expired stock, or velocity — even though `wms_slotting_velocity_view` and `wms_pick_waves` already exist. It also picks a source by falling back to `_wms_default_putaway()`, ignoring FEFO, lot, and LPN.

5. **No operator execution path and no event fabric participation.** No scan intents exist for replenishment (`wmsScanIntent.ts` has putaway/pick/pack/load/count/QC/returns — nothing for replenish), `MobileNextTask` routes `replenish` to a dead `/warehouse/tasks` path, generation emits no `warehouse.replen.*` topic, and the supervisor page polls every 15s instead of using `useWmsRealtimeSync`.

Conclusion: rules and task-shell exist; the **execution layer, decision layer, and rule hierarchy do not**. This is a rebuild of the subsystem, not a page redesign.

## What will be built

### 1. Domain & data model (migration)
- **Consolidate on one rule aggregate.** Extend `wms_replenishment_rules` into a hierarchical, scoped model: `scope` (`warehouse` | `zone` | `category` | `product` | `pick_face`), nullable scope keys, `strategy` (`min_max`, `demand_driven`, `topoff`, `manual`), `effective_from`/`effective_to`, `velocity_class` filter, `emergency` flag, `row_version`. Drop the unused `wms_replen_rules` and slot its `target_qty`/`source_zone_id` concepts into the surviving table. `wms_slotting_rules` is left alone.
- **`wms_replen_orders`** — the replenishment *demand* aggregate (what needs refilling, why, from which rule, with which computed quantity and confidence), separate from `wms_tasks` (who does the physical move). Enterprise systems separate the plan from the work; this is what lets a supervisor approve, re-prioritise, split, or cancel before dispatch.
- **State machine** on the order: `planned → approved → dispatched → in_progress → completed | short | cancelled`, written only by `wms_transition_replen_order`, with `row_version` optimistic locking — same shape as every other WMS aggregate (ADR 0101).
- Source stock is **reserved** when an order is dispatched, released on cancel/short.

### 2. Decision engine (SQL, deterministic)
`plan_replenishment(p_warehouse_id, p_mode)` replaces `generate_replenishment_tasks`:
- resolves the **effective rule** per pick face by hierarchy precedence (pick_face > product > category > zone > warehouse), honouring effective dates and emergency overrides;
- computes projected pick-face position = on-hand − allocated to open waves/picks − blocked/quarantined/expired, + inbound replen already in flight;
- selects a source by FEFO/lot/LPN-aware candidate search across reserve locations in the same warehouse, respecting temperature/hazmat zone constraints already modelled on `stock_locations`;
- rounds to pack multiple, clamps to source availability, records a **decision trace** (`reason_code`, inputs, chosen source, rejected candidates) on the order so every decision is explainable and reproducible;
- is idempotent per (pick face, product) while an order is open;
- runs in **plan** or **plan_and_dispatch** mode; auto-dispatch is a rule-level setting so supervisor approval can be required for high-value/controlled stock.
- Mirrored by a **pure TypeScript reference engine** (`src/lib/warehouse/replenishment/engine.ts`) with unit tests, following the existing `src/lib/replenishment/engine.ts` precedent.

### 3. Execution (this is the missing half)
- **`complete_replenish_task(p_task_id, p_scans, p_quantity, p_lot, p_lpn)`** — validates scanned source location, LPN/lot and destination pick face against the task, writes the `stock_movements` pair through the sanctioned Inventory movement helper (WMS never writes quants directly, ADR 0079), transitions task and order, releases reservation, emits events. Short-pick and over-pick paths raise a `wms_exceptions` row rather than silently succeeding.
- **Scan intents** `replen.source_location`, `replen.lpn`, `replen.item`, `replen.destination` added to `wmsScanIntent.ts`, so the operator flow is scan-source → scan-LPN/item → confirm qty → scan-destination → complete, with GS1 parsing and audio/haptic feedback already provided by the registry. Hardware stays abstracted: pages request a scan intent, never a device.
- **`MobileNextTask`** routes `replenish` to the new operator screen and auto-advances to the next task on completion.

### 4. Event fabric & realtime
New topics registered in `src/features/warehouse/events/topics.ts` and `WMS_MODULE_OWNERSHIP.md`: `warehouse.replen.planned`, `.approved`, `.dispatched`, `.completed`, `.short`, `.cancelled`, emitted by `AFTER` triggers on `wms_replen_orders` with idempotency key `wms.replen_order:<id>:<state>`. `wms_replenishment_rules` and `wms_replen_orders` join `useWmsRealtimeSync`; the 15-second poll on the Replenishment page is removed.

### 5. Control-centre UI
The page becomes a supervisor workspace, decomposed into `src/features/warehouse/replenishment/*` components (no monolithic page file):
- **KPI strip**: open orders, overdue, blocked/short, critical pick faces, throughput last shift, operator utilisation.
- **Live work queue** (virtualized TanStack Table): order, rule scope, pick face, projected stockout, source, qty, age vs SLA, assignee — with bulk approve / dispatch / re-prioritise / cancel.
- **Pick-face health board**: pick faces ranked by projected minutes-to-stockout, colour-tiered, reusing the existing `getReplenishmentSignal` tiering vocabulary.
- **Decision drawer**: for any order, the full decision trace — which rule matched and why, what the alternatives were, what stock was excluded.
- **Rule workbench**: hierarchical rule tree with scope badges, effective-date windows, and an *effective-rule preview* for a chosen pick face.
- Printing (task sheet, transfer/LPN label) is delegated to the existing document/print platform via the established `printLabelByTemplate` path — Replenishment generates no documents itself.

### 6. Guardrails
- ADR `0106-replenishment-execution-subsystem.md` recording the plan/execute split, rule hierarchy precedence, and event catalog.
- Architecture tests extending the existing `wms-phase*.test.ts` suite: no direct `.update({ state })` on the new tables, no `supabase.rpc` in pages (aggregate wrapper only), topic-vocabulary parity with the ownership doc.
- Unit tests for the reference engine (hierarchy resolution, projection maths, FEFO source choice, idempotency).

## Technical notes
- Existing tables reused: `wms_tasks`, `stock_quants`, `stock_locations`, `wms_pick_waves`, `wms_license_plates`, `wms_exceptions`, `wms_slotting_velocity_view`, `business_event_outbox`.
- All new tables get GRANTs + RLS scoped by `user_business_access`, matching the surviving rule table rather than the admin-only pattern of the dropped one.
- `wms_replen_rules` is dropped only after confirming it holds no rows; if rows exist they are migrated into `wms_replenishment_rules` in the same migration.
- The procurement-side `/replenishment` (reorder → PO) is out of scope and stays where it is; the ADR names the boundary so the two are never conflated again.

## Delivery order
1. Migration: rule consolidation + `wms_replen_orders` + FSM + triggers + events.
2. `plan_replenishment` engine + TS reference engine + tests.
3. `complete_replenish_task` + scan intents + operator screen + MobileNextTask routing.
4. Supervisor control centre UI + realtime wiring.
5. ADR + architecture tests + ownership doc update.

---

**Status: complete (2026-08-03).** All five delivery steps shipped — migration + FSM, `plan_replenishment` engine and TS reference engine with tests, `complete_replenish_task` with scan intents, the supervisor control centre with realtime, and ADR 0108 + architecture guards.
