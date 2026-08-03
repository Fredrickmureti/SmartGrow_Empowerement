# Cross-Dock — architecture audit verdict and enterprise redesign

## 1. What cross-docking actually is

Cross-docking is a flow-through discipline, not a storage activity. Goods arriving at an inbound door are matched against demand that already exists (a sales order, a store replenishment, a branch transfer, a production order), and move directly from the receiving dock to an outbound staging lane and onto a departing trailer — never entering reserve storage.

It exists to remove the four most expensive touches in a DC: put-away travel, storage occupancy, replenishment, and pick travel. It pays off for high-velocity, pre-allocated, short-shelf-life or retail-distribution flows. It must NOT be used when goods need QC quarantine, when demand is speculative, when the outbound departure is far away (goods would sit in a staging lane, which is worse than a bin), when batch/serial or cold-chain constraints demand controlled handling, or when partial quantities would break a ship-complete commitment.

The decision is time-boxed: an opportunity is only valid inside the window between receipt completion and the carrier cut-off. That single fact is what makes cross-dock an engine, not a list.

## 2. Verified current state

Confirmed by reading the database and the code:

- One table, `wms_crossdock_opportunities`: grn/receiving line, product, quantity, one sales order + item, `status` (`open|staged|cancelled`), `stage_task_id`, timestamps, `cancel_reason`. No rules table, no scoring, no dock/carrier/appointment column, no cut-off time, no lifecycle beyond three states.
- Two detectors: `evaluate_crossdock_on_grn` (trigger on GRN completion) and `evaluate_crossdock_on_receiving_line` (called from `BusinessSagaMount` off `warehouse.receiving.line_captured`). Both match the single oldest open sales order line for the product, FIFO, and stop. No transfer orders, no replenishment, no manufacturing demand, no split across orders, no capping of quantity to outstanding demand.
- Qualification is hardcoded to exactly one rule: skip lines with an open QC inspection. Shelf life, batch, hazmat, cold chain, customer priority, dock availability and carrier departure are consulted nowhere.
- `confirm_crossdock_stage` only flips `status='staged'` and emits an event. It moves no stock, reserves nothing against the sales order, allocates no staging location, reserves no outbound dock, creates no load task.
- Task generation exists only in the receiving-line path (one `pack` task, priority 150, no source or destination location). The GRN path creates no task at all — the two detectors are not equivalent.
- Three topics only: `warehouse.crossdock.matched|staged|cancelled`. No `qualified`, `rejected`, `expired`, `loaded`, `completed`, `broken`.
- No reaction to downstream reality: if the sales order is cancelled, the quantity is short-received, QC later fails, the appointment is missed or the dock is pulled, the opportunity stays `open` forever. Nothing expires it.
- UI is a filtered table with a 15-second poll and three count badges. It shows raw UUID prefixes for product and sales order; no urgency, countdown, dock, operator, savings or exception surface. It calls `supabase.rpc` directly from the page, violating `docs/architecture/WMS_MODULE_OWNERSHIP.md` §1 (pages never call RPCs; `aggregates/crossdock/*` owns them). That directory does not exist.
- No realtime subscription, no printing, no hardware/RF surface, no KPIs.

**Verdict: a passive match log with two buttons.** Detection is real and correctly event-driven; the qualification engine, the orchestration half and the supervisor decision surface do not exist. Domain boundaries are not violated — it does not write stock — but only because it does almost nothing.

## 3. Target architecture

Cross-dock is an **orchestrator**. It owns the opportunity, its qualification and its lifecycle. It owns no stock, no task execution semantics, no documents, no dock calendar — it consumes Receiving, Yard/Dock, Sales/Transfers, Inventory reservation, Task Management, Dispatch and the document platform.

```text
detected -> qualified -> approved -> staging -> staged -> loaded -> completed
               |            |          |
            rejected     expired    broken (demand or supply changed)
```

Detection stays event-driven off receiving; a scheduled sweep re-qualifies and expires. Qualification becomes a configurable rule set, not an IF inside a function.

## 4. Phased implementation

**Phase 1 — Domain model.** New `wms_crossdock_rules` (business/warehouse scoped: min remaining shelf life, allowed product classes, hazmat/cold-chain policy, customer priority floor, max hours to carrier cut-off, min/max quantity, auto-approve threshold, active flag, priority). Extend `wms_crossdock_opportunities` with lifecycle enum, `demand_type` (`sales_order|transfer|replenishment|production`), generic `demand_doc_id`/`demand_line_id`, `qualified_at`, `score`, `reject_reason`, `expires_at` (carrier cut-off), `staging_location_id`, `outbound_dock_id`, `appointment_id`, `assigned_user_id`, `load_task_id`, `savings_estimate`, `row_version`. Backfill existing rows. Grants, RLS, audit history.

**Phase 2 — Detection & qualification engine.** One shared internal evaluator: caps quantity to outstanding demand, splits across multiple demand lines, scores candidates, evaluates the rule set, writes `qualified` or `rejected` with a reason. Extend detection to transfer orders and replenishment demand. Unify the GRN and receiving-line paths onto it. Add `wms_crossdock_requalify_sweep` on pg_cron to re-score, expire past cut-off, and break opportunities whose demand vanished.

**Phase 3 — Orchestration.** `wms_crossdock_approve` / `_reject` / `_assign_staging` / `_confirm_staged` / `_complete`, all with `p_row_version`. Approval reserves the demand line, allocates a staging location, reserves the outbound dock, and fans out real `wms_tasks` (unload → optional inspect → move → stage → load) linked to the opportunity so labour and RF pick them up. Loading links the opportunity to the loading manifest so dispatch closes it. Emit `warehouse.crossdock.qualified|rejected|approved|staged|loaded|completed|expired|broken`, registered in `topics.ts`, `wms_events_catalog` and the ownership doc.

**Phase 4 — Exception handling.** Saga subscribers that raise `wms_exceptions` and break the opportunity on: sales order cancelled, short/over receipt vs ASN, QC failure, damage, trailer no-show, appointment cancelled, dock pulled, priority change. Every break carries a typed reason and a supervisor resolution.

**Phase 5 — Decision centre UI.** Replace the table with a supervisor console: urgency-sorted lanes (`Needs decision` / `In motion` / `Blocked`), carrier cut-off countdown per row, real product and order names, customer, dock, assigned operator, current stage, storage-and-travel savings, blocked/rejected reasons, bulk approve, and a rules editor. Supabase Realtime on the opportunities table plus the warehouse topic stream replaces the 15s poll. Move every RPC call into `src/features/warehouse/aggregates/crossdock/*` per the ownership rule.

**Phase 6 — Documents, hardware, KPIs.** Cross-dock routing/stage label requested from the document platform (never generated locally) and printed through the existing print router to the label printer bound to the dock. RF/handheld screens reuse the existing task queue — cross-dock adds no hardware surface of its own. KPI strip plus `wms_crossdock_metrics_view`: success rate, storage days avoided, handling touches avoided, dwell time, dock utilisation, fulfilment acceleration, by customer / supplier / warehouse / operator.

**Phase 7 — Guards and ADR.** Extend `wms-phase12.test.ts` and add `crossdock-orchestration.test.ts`: no direct `.update()` on the table, no `supabase.rpc` in the page, every lifecycle state has a topic, every topic registered. Supersede ADR 0083's cross-dock half with **ADR 0106 — Cross-dock orchestration engine**.

## 5. Technical notes

All state writes stay RPC-only and `SECURITY DEFINER` with optimistic concurrency (`row_version`), matching ADR 0101. Events go to `business_event_outbox` with `wms.crossdock:<id>:<transition>` idempotency keys — never straight to Realtime. Stock truth remains in Inventory: cross-dock reserves and tags, and the existing Receiving and Dispatch movement paths continue to write `stock_movements`.