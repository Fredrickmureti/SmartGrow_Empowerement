# Dock Scheduling & Yard Operations — Project Plan (authoritative status)

Last updated: 2026-08-03

## Status summary

All phases (A–G) of the Dock Scheduling & Yard Operations roadmap are
implemented and verified. The module is at a coherent, production-ready
state. **No phase is currently active** — the roadmap is complete.

## Completed & verified

### Phase A — Appointment as a first-class object (done)
- `wms_dock_appointments` extended: `appointment_no` (sequence-backed
  `APT-XXXXXX`), `priority`, driver/trailer/tractor fields, `qr_token`,
  `scheduled_departure`, lifecycle timestamps.
- `wms_appointment_documents` — typed polymorphic links to PO / ASN /
  goods receipt / SO / delivery note / manifest / return / transfer.
- Existing rows backfilled with numbers and QR tokens.
- UI: `src/pages/warehouse/AppointmentPlanner.tsx` captures the full
  enriched schema with live feasibility feedback.

### Phase B — Dock capability model (done)
- `warehouse_docks.capabilities` (JSONB: refrigerated, hazmat, tail_lift,
  dock_leveller, max_vehicle_length_m, max_weight_kg) and
  `operating_hours`, `default_turn_minutes`.
- `wms_dock_downtime` for maintenance windows.
- `schedule_dock_appointment` rewritten: feasibility validation
  (capability match, overlap, downtime, operating hours) enforced
  server-side.

### Phase C — Yard zones (done)
- Yard slot zone vocabulary (parking / waiting / staging / quarantine /
  maintenance); `check_in_trailer` is zone-aware.
- Presentation vocabulary centralised in
  `src/features/warehouse/dock/dockScheduling.ts`.

### Phase D — Gate operations subsystem (done)
- `wms_gate_events` with RLS + triggers; RPCs `gate_check_in`,
  `gate_approve`, `gate_exit`. All writes RPC-only.

### Phase E — Scheduling command centre (done)
- `src/features/warehouse/dock/DockTimeline.tsx` — resource-timeline
  Gantt (one lane per dock), now-marker, drag-to-reschedule with 15-min
  snap validated server-side (`@dnd-kit/core`).
- `AppointmentDrawer.tsx` — progressive disclosure: QR gate pass, linked
  documents, gate event timeline.
- `DockSchedule.tsx` — KPI strip (utilisation, dwell, on-time %),
  list/timeline toggle, "On site now" rail.
- `useDockScheduling.ts` — all data hooks; no direct table writes.

### Phase F — Hardware-ready gate ops (done)
- `src/pages/warehouse-mobile/MobileGate.tsx` handheld guard console.
- `gate.pass` scan intent registered in `wmsScanIntent.ts`; route wired
  in `src/apps/warehouse-mobile/routes.tsx` and `MobileHome.tsx`.

### Phase G — Cross-module origination (done)
- `RequestDockSlotDialog.tsx` — reusable slot request surface for
  Purchasing / Sales / Returns without coupling those modules to WMS
  internals.

## Verification performed
- `bunx tsgo --noEmit` — clean.
- Routes `/warehouse-app/schedule` and `/warehouse-app/schedule/new`
  resolve to `DockSchedule` / `AppointmentPlanner`.
- Smoke test of the schedule page and planner in preview.

## Pending
None for this module.

## Instructions for the next agent

1. **Verify before building.** Re-check this module against
   enterprise-grade expectations before starting anything new:
   - Confirm every appointment/yard/gate mutation goes through an RPC
     (no direct `.from('wms_*').insert/update` in `src/`).
   - Confirm RLS policies exist on `wms_appointment_documents`,
     `wms_dock_downtime`, `wms_gate_events`.
   - Run `bunx tsgo --noEmit` and the architecture tests under
     `src/test/architecture/`.
2. **Do not start unrelated work inside this module.** Dock/yard is
   closed. The next logical milestone lives in the wider warehouse
   roadmap — see the archived plans in `.lovable/plan/` (most recent:
   cycle-count verification verdict, 2026-08-03) for the next
   chronological item.
3. Keep this file updated as the authoritative status document whenever
   a phase lands.
