# ADR 0101 — WMS Domain, FSM & Event Catalog (Phase 1)

Status: Accepted (Phase 1.1 shipped)
Depends on: ADR 0079 (Inventory vs. WMS boundary), ADR 0080 (Warehouse master),
ADR 0064/0068/0076/0078 (Inventory ledger), ADR 0037/0099 (Hardware runtime).

## Context

Phase 0 of the WMS shipped a substrate — `wms_license_plates`, `wms_tasks`,
`wms_count_sessions`, `receiving_appointments`, `pick_waves`, `pack_stations`,
`loading_manifests`, `qc_inspections` — plus a Warehouse app shell. But
state machines lived in page code, task assignment was a raw UPDATE, LPN
transitions were unguarded, exception routing was ad-hoc, and the event
catalog was implicit.

## Decision

Phase 1 formalises the domain along three axes.

### 1. Aggregates & FSM guards
Every physical aggregate gets a canonical state set enforced by an
`ALTER TYPE ... ADD VALUE` set of enum extensions plus a `SECURITY DEFINER`
transition function that is the only writer of `state`:

| Aggregate | Enum | Transition RPC |
|---|---|---|
| Task | `wms_task_state` (+ `available`, `claimed`, `completed`, `exception`) | `wms_transition_task` |
| LPN  | `wms_lpn_state`  (+ `receiving`, `putaway`, `stored`, `picked`, `packed`, `staged`, `loaded`, `quarantined`, `voided`, `consumed`) | `wms_transition_lpn` |
| Exception | `wms_exception_state` | `wms_resolve_exception` |
| Receiving session | `wms_receiving_state` | `wms_transition_receiving` |
| Return | `wms_return_state` | `wms_transition_return` |

Every aggregate row carries `row_version bigint not null default 1` and
every transition RPC accepts `p_row_version` — optimistic concurrency is
non-negotiable. Direct `UPDATE ... SET state = ...` is forbidden.

### 2. Polymorphic task engine
`wms_tasks` is the single work surface for every operator action.
Three new RPCs replace ad-hoc UPDATEs:

- `wms_claim_next_task(warehouse, types[], lease_seconds)` — picks the
  highest-priority `pending|available` task within the warehouse using
  `FOR UPDATE SKIP LOCKED`, stamps the caller into `assignee_user_id`,
  sets `state=claimed`, sets `lease_expires_at = now() + lease`.
- `wms_task_heartbeat(task_id)` — extends `lease_expires_at`.
- `wms_task_reap_expired(warehouse)` — supervisor sweep: any `claimed|in_progress`
  task past `lease_expires_at` goes back to `available` with an exception.

### 3. Event catalog
Every emitted topic is enumerated in `wms_events_catalog` (SQL) and
`src/features/warehouse/events/topics.ts` (TS). Idempotency keys follow
`wms.{aggregate}:{id}:{transition}` (ADR 0079 §3). Producers use
`business_event_outbox` — never publish directly to Realtime.

### 4. New surfaces
- `wms_exceptions` + `/warehouse-app/exceptions` — one queue for every
  blocker with typed resolutions.
- `wms_receiving_sessions` — a unit of ASN unload work that groups GRN
  captures and drives putaway task fan-out.
- `wms_return_orders` — RMA execution surface with disposition
  (`return_to_stock`, `quarantine`, `scrap`, `refurbish`).
- `wms_replen_rules`, `wms_slotting_rules` — declarative rule tables
  read by Phase 3 engines.

## Consequences

- Page code must migrate off direct `.update({ state })` calls onto the
  transition RPCs. A follow-up pass in Phase 1.3 sweeps existing pages.
- Realtime consumers can now subscribe to `business_event_outbox` filtered
  by topic prefix `warehouse.*` instead of dozens of table channels.
- Exception routing becomes uniform — Phase 2 QC/receiving/count code
  simply INSERTs into `wms_exceptions` on failure.
- Rollback is a matter of dropping the new RPCs and the four new tables;
  the enum additions are additive.
