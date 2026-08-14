# ADR 0076 — Stock Event Fabric

**Status:** Accepted (2026-07-17) · **Supersedes:** none · **Related:** 0064, 0068

## Context

The Inventory Foundation Audit (`.lovable/inventory-foundation-audit.md` §11) called out that `business_event_outbox` infrastructure is well-designed but nothing publishes inventory events into it. Downstream modules (finance COGS, replenishment, external WMS adapters) couple directly to `stock_movements` triggers, which blocks event-sourced reporting and cross-service scale.

## Decision

Every insert into `public.stock_movements` publishes a `stock.movement.*` event into `public.business_event_outbox` in the same transaction (outbox pattern) via `AFTER INSERT` trigger `tg_stock_movement_emit_event`.

Event type is derived from `movement_type`:

| movement_type prefix | event_type |
|---|---|
| purchase / grn / inbound / return_from_customer | `stock.movement.received` |
| sale / pos_sale / shipment / delivery / outbound / return_to_vendor | `stock.movement.dispatched` |
| transfer_out / transfer_in / transfer | `stock.movement.transferred` |
| adjustment / opening_balance / stock_count / writeoff / scrap | `stock.movement.adjusted` |
| _fallback_ | `stock.movement.posted` |

Idempotency key = `stock.movement:<movement_id>` — retried inserts never double-emit.

Rows with `is_sample_data = true` are skipped so QA fixtures don't inflate the outbox.

## Client-side emission

Client code (import handlers, ad-hoc workflows) MUST route through `public.emit_business_event(...)` RPC — direct client inserts to `business_event_outbox` are RLS-denied.

## Consequences

- Downstream services can subscribe once and stop polling `stock_movements`.
- The trigger uses `EXCEPTION WHEN OTHERS THEN RAISE WARNING` so an outbox failure never fails a stock movement — audit gap #3 explicitly accepted this tradeoff.
- Adds one row per movement to `business_event_outbox`; existing pending-status partial index handles the volume.

## Follow-up

Migrate one existing consumer (Finance COGS JE, or replenishment) to subscribe to `stock.movement.dispatched` instead of a direct trigger, as proof of the fabric. Tracked in the next session.
## Addendum — topic registration is mandatory (2026-08-14, Phase 8 behavioural sweep)

A real stock adjustment run against live data surfaced a routing defect: six
`stock.*` / `inventory.*` topics were emitted by triggers but had no row in
`business_event_topics`. `pos_topic_handler_scope()` falls back to `'server'`
for unknown topics, so rows emitted with `handler_scope = 'host'` (the column
default) were claimed by the server `outbox-dispatcher` and dead-lettered as
`posting.contract_violation: unknown_event_type`.

Rules, now ratcheted in `supabase/tests/inventory_event_fabric_test.sql` §6:

- Every topic literal an emitter uses MUST have a `business_event_topics` row.
- The registered `handler_scope` MUST match where the handler actually lives:
  `host` for topics handled by the in-app saga (`stock.adjustment.posted`,
  `stock.transfer.approved|completed`, `stock.count.completed|cancelled`),
  `server` for topics handled by `outbox-dispatcher`
  (`inventory.*`, including the record-only
  `inventory.physical_count.posted` and `inventory.reorder.recompute`).
