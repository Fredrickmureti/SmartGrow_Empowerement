# Dock Scheduling & Yard Operations — Architecture Audit and Build Plan

## What I inspected

`src/pages/warehouse/DockSchedule.tsx`, `AppointmentPlanner.tsx`, `YardBoard.tsx`, `InboundDashboard.tsx`, `OutboundDashboard.tsx`, `SupervisorDashboard.tsx`, the receiving/returns feature folders, `src/features/warehouse/events/topics.ts`, `src/features/warehouse/scanning/wmsScanIntent.ts`, and the live schema for `wms_dock_appointments`, `warehouse_docks`, `wms_yard_slots`, `wms_trailer_visits`.

## Verdicts

### 1. Dock appointment as a business object — ⚠ Needs improvement

`wms_dock_appointments` holds: warehouse, dock, type (inbound/outbound), carrier, a free-text `reference`, window start/end, state, arrived_at, completed_at, cancelled_reason.

Confirmed missing: appointment number, supplier/customer party, trailer, tractor, driver, priority, scheduled departure vs actual departure as distinct fields, and any typed link to a source document. `reference` is a text box — the appointment cannot say "this is for PO-1042 / ASN-77 / Shipment-9". That single gap is why the module reads as a calendar rather than an orchestrator.

### 2. Appointment origination — ❌ Architecturally incorrect

`AppointmentPlanner.tsx` is the only creation path and it is a manual form (warehouse, dock, type, carrier, reference, window). Nothing in Purchasing, Sales, Receiving, Dispatch, Transfers, or Returns can request a slot. Enterprise scheduling is pulled from the document that needs the door.

### 3. Dock resources — ❌ Architecturally incorrect

`warehouse_docks` has only `code`, `name`, `dock_type`, `is_active`, `notes`. No dimensions, refrigeration, hazmat, weight limit, equipment, operating hours, maintenance windows, or capacity/turn-time. Slot feasibility therefore cannot be validated — any trailer can be booked to any door.

### 4. Yard model — ⚠ Needs improvement

`wms_yard_slots` (code, slot_type, status) plus `wms_trailer_visits` is a genuinely good foundation, and the RPC-only write discipline (`check_in_trailer`, `assign_trailer_to_dock`, `depart_trailer`, server-computed dwell, `SKIP LOCKED` slot claim) is correct. What is missing is the rest of the yard vocabulary: waiting lanes, inbound/outbound queues, staging zones, overflow, dock approach lanes — everything is one flat "slot".

### 5. Gate operations — ❌ Missing

Check-in captures trailer ref, driver name/phone and `seal_in`. There is no driver identity verification, no badge/document capture, no security approval step, no gate pass issuance, no gate-exit event distinct from departure. Today's "gate" is a desktop form.

### 6. Live dock operations & UI — ⚠ Needs improvement

`DockSchedule.tsx` (247 lines) is a read-only day list grouped by dock with state-transition buttons. No timeline/Gantt, no live occupancy board, no conflict visualisation, no drag-to-reschedule, no countdown/late detection, no yard map. Realtime plumbing exists (`useWmsRealtimeSync` covers appointments) but the UI doesn't exploit it. No scheduling/Gantt library is installed — this would be hand-rolled unless we adopt one.

### 7. Hardware readiness — ⚠ Needs improvement

A strong scan substrate exists (`useWmsScanIntent`, `/wm/*` mobile surface, label printing infrastructure), but there is no `gate.*` or `appointment.*` scan intent, no appointment QR, no gate-pass or dock-assignment label, and no mobile gate/yard screen. The foundation supports RFID-style ingest later; nothing is wired today.

### 8. Domain boundaries — ✅ Enterprise-ready

Receiving reads trailer visits read-only via `useReceivingTrailerVisits` and keys off `appointment_id`; the yard owns physical state; appointment lifecycle events already publish on the outbox (`warehouse.appointment.*`, `warehouse.yard.*`). No duplicated dock-allocation logic found. This is the part worth preserving verbatim.

## Build plan

### Phase A — Appointment becomes a first-class object
Extend `wms_dock_appointments`: `appointment_no` (sequence), `priority`, `party_contact_id`, `trailer_ref`, `tractor_ref`, `driver_name`/`driver_phone`, `scheduled_departure`, `departed_at`, `qr_token`. Add `wms_appointment_documents` (appointment_id, doc_type, doc_id) as the typed polymorphic link to PO / ASN / SO / shipment / transfer / return. Extend `schedule_dock_appointment` to accept them; keep RPC-only writes and the existing EXCLUDE overlap constraint.

### Phase B — Dock capability model
Extend `warehouse_docks` with `capabilities` (jsonb: refrigerated, hazmat, tail-lift, weight limit, max length/height), `operating_hours`, `default_turn_minutes`. Add `wms_dock_downtime` for maintenance windows. Add a `check_dock_feasibility` RPC that `schedule_dock_appointment` calls — infeasible bookings are rejected with a reason, not silently allowed.

### Phase C — Yard zones
Add `zone_kind` to `wms_yard_slots` (waiting_lane, parking_bay, staging, overflow, approach_lane) plus `sequence`/`capacity`, and an inbound/outbound queue view. Check-in parks by zone kind rather than first-free.

### Phase D — Gate operations
New `wms_gate_events` (visit_id, event_type, actor, identity_ref, seal_ref, approval, timestamp, notes) with `gate_check_in`, `gate_approve`, `gate_exit` RPCs emitting `warehouse.gate.*`. Adds the audited actor/timestamp chain the audit asks for.

### Phase E — Scheduling command centre UI
Replace the day list with a resource-timeline board: docks as rows, time as columns, appointments as draggable blocks, live occupancy overlay from `wms_trailer_visits`, conflict/late highlighting, KPI strip (utilisation, dwell, on-time %, no-shows). Adopt a maintained scheduling library rather than hand-rolling — evaluation shortlist: `@fullcalendar/resource-timeline`, `dnd-timeline`, `bryntum` (commercial). Recommendation to confirm before build: FullCalendar resource-timeline (MIT core + premium resource plugin) or a `dnd-kit`-based custom lane grid if licensing is a blocker.

### Phase F — Hardware & mobile gate
Appointment QR (`qr_token`), `gate.appointment` scan intent, `/wm/gate` mobile check-in screen (scan QR → verify driver → seal → assign yard/dock), and gate-pass + dock-assignment label templates through the existing label pipeline.

### Phase G — Cross-module orchestration
"Request dock slot" actions on PO/ASN, outbound shipment, transfer, and return records; carrier-facing confirmation; auto-suggest slot from feasibility + capacity.

## Technical notes

- All state transitions stay in `SECURITY DEFINER` RPCs; PostgREST keeps `SELECT`-only on operational tables. Every new transition emits to `business_event_outbox` with `wms.<entity>:<id>:<state>` idempotency keys, matching ADRs 0076/0079/0080.
- Receiving keeps ownership of unloading, Dispatch keeps ownership of outbound execution; Dock Scheduling owns only timing, door allocation, and physical traffic state.
- New ADR 0082 documents the appointment/document link and the gate event chain.
- Each phase ships schema + RPC + UI + architecture guard test together.

## Confirm before I build

Phase E's library choice and whether Phases A–D should land as one migration wave or sequentially.
