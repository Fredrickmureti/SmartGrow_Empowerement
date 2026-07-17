# ADR 0080 — WMS Yard & Trailer Management

**Status:** Accepted (2026-07-17) · **Related:** 0079 (Inventory vs Warehouse split), Phase 6 (dock appointments), Phase 9 (this ADR).

## Context

`wms_dock_appointments` (Phase 6) gave us a *scheduled* view of the dock,
but nothing captured what actually happened when a trailer physically
arrived: no arrival timestamp separate from the appointment window, no
yard-parking record between the gate and the dock, no seal chain of
custody, no dwell measurement, no place to record `no_show`. Yard-ops
KPIs (dwell, on-time%, detention exposure, seal breaks) had no source
data.

## Decision

Introduce two tables and three RPCs.

### `wms_yard_slots` — master data

Physical parking positions inside the yard. Business-scoped, warehouse
admins write via PostgREST. Columns: `code`, `slot_type
(inbound|outbound|either|hazmat|reefer)`, `status
(available|occupied|blocked)`.

### `wms_trailer_visits` — operational, RPC-only writes

One row per trailer arrival. Links to `carriers`, `wms_yard_slots`,
`warehouse_docks`, and optionally `wms_dock_appointments`. Captures
`seal_in`, `seal_out`, `arrived_at`, `docked_at`, `departed_at`,
`dwell_minutes`, and a `status` state machine
(`arrived → in_yard → at_dock → departed`, plus `no_show`). PostgREST
grants only `SELECT`; every transition goes through `SECURITY DEFINER`
RPCs.

### RPCs (all emit `warehouse.yard.*` events)

- `check_in_trailer(warehouse_id, trailer_ref, carrier_id?,
  driver_name?, driver_phone?, seal_in?, appointment_id?)` — records
  arrival, auto-parks in the first free yard slot (row-locked with
  `SKIP LOCKED` to survive concurrent gate scans), marks the slot
  `occupied`, promotes the appointment from `scheduled` to `arrived`.
- `assign_trailer_to_dock(visit_id, dock_id)` — validates the dock is
  idle, links the visit, frees the yard slot, stamps `docked_at`, and
  advances the appointment to `in_progress`.
- `depart_trailer(visit_id, seal_out?)` — stamps `departed_at`,
  computes `dwell_minutes` server-side, releases dock and any residual
  yard slot, closes the appointment.

Every RPC calls `emit_yard_event(...)` which writes into
`business_event_outbox` with idempotency key
`wms.trailer_visit:<id>:<status>` — same shape as ADRs 0076, 0079.

## Appointment ↔ visit ↔ dock linkage

- `wms_dock_appointments` remains the *planned* view; its EXCLUDE
  constraint keeps two active appointments from overlapping on the same
  dock. Nothing changes there.
- `wms_trailer_visits.appointment_id` is nullable — walk-ins are
  first-class citizens. When present, RPCs advance the appointment
  state machine in lock-step (`scheduled → arrived → in_progress →
  completed`).
- The visit's `dock_id` is the ground truth for "who is at the dock
  right now"; `assign_trailer_to_dock` rejects double-booking.

## Consequences

- Dwell, on-time, and seal-integrity KPIs are now computable directly
  from `wms_trailer_visits`.
- `business_event_outbox` gains three new event types
  (`warehouse.yard.checked_in`, `.docked`, `.departed`) that Phase 11
  (3PL billing) will consume as activity signals.
- No stock effect. Inventory movements remain gated by Receiving
  (Phase 2) and Dispatch (Phase 5) — the yard is a pre-inventory
  operational layer.

## Non-goals

- Gate-camera/OCR ingest (out-of-band capture; RPCs accept the fields).
- Detention billing rules (belongs in Phase 11 tariffs).
- Multi-trailer power-unit modelling (add if a customer needs it).
