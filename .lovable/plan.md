# Yard & Trailer Management — Verification Result + Phases 5–8

## 1. Verification of the previous engineer's work (done this turn)

Checked directly against the database and the codebase, not against the handoff note.

Confirmed genuinely implemented:

- Tables `wms_trailers`, `wms_yard_moves`, `wms_yard_slots`, `wms_trailer_visits`,
  `wms_gate_events`, `wms_dock_appointments` all exist.
- Functions `gate_check_in`, `gate_exit`, `relocate_trailer`,
  `assign_trailer_to_dock`, `release_trailer_from_dock`,
  `approve_trailer_departure`, `mark_trailer_no_show`,
  `trailer_departure_blockers`, plus the raw `check_in_trailer` /
  `depart_trailer` internals — all present.
- Realtime publication carries `wms_trailers`, `wms_yard_moves`,
  `wms_yard_slots`, `wms_trailer_visits`.
- Label seeding functions `wms_seed_yard_label_templates` and
  `wms_seed_default_label_templates` exist; yard printing goes through
  `printWmsLabel` → PrintService (no shadow print path).
- Routes `/warehouse-app/yard`, `/yard/gate`, `/yard/trailers` are wired and
  nav-linked; legacy `YardBoard.tsx` is gone.
- Guard tests pass: `wms-phase9.test.ts` (6) and `wms-label-keys-sync.test.ts` (2).

Conclusion: the handoff is accurate. No rework of Phases 1–4 is required. The
claim that the module is "complete" is not accurate — the parent brief's
hardware/mobile and execution-integration requirements were never implemented.

## 2. Gaps found (evidence-based, these become the remaining phases)

1. **No hardware participation.** No yard file references any scanner hook,
   while Receiving, Putaway, Loading Bay, Counts and License Plates all use
   scan input. Gate check-in is keyboard-only — trailer codes, seals, plates
   and appointment references cannot be scanned.
2. **No mobile surface.** Gate Console and the Control Tower have no
   responsive/touch path; a yard marshal or gate officer on a handheld cannot
   check in, relocate, assign a dock or clear a departure.
3. **Yard moves are not work.** `wms_yard_moves` records movement *after the
   fact*. There is no assignable jockey task, so a supervisor cannot dispatch
   "move trailer T-12 from Y-03 to Dock 4" to an operator, and yard labour is
   invisible to `wms_tasks` / the Labour board.
4. **Departure readiness is one-way.** `trailer_departure_blockers` is only
   consulted at the moment of clearance. Neither the Control Tower nor Dispatch
   shows load readiness, so nobody sees a trailer becoming ready.
5. **Trailer contents are unmodelled.** A visit knows its appointment but not
   what it carries, so inbound receiving and outbound manifests aren't visible
   from the trailer.

## 3. Phase 5 — Yard execution layer (jockey work orders)

- Migration: yard move *requests* as first-class tasks on the existing
  `wms_tasks` fabric (task type `yard_move`), created by a new
  `request_yard_move` RPC and closed by `relocate_trailer` /
  `assign_trailer_to_dock` when the operator completes them. Keep
  `wms_yard_moves` as the completed-movement ledger.
- Supervisor drag on the yard map creates a task instead of mutating position
  directly when a "dispatch to jockey" mode is on; direct relocate stays for
  supervisor override and is logged with an override actor.
- Yard tasks appear in Operator tasks and Labour with the same lifecycle as
  pick/putaway tasks.

## 4. Phase 6 — Hardware and mobile

- Scan-first Gate Console: appointment reference, trailer code, seal and
  driver ID captured through the project's scanner session hooks
  (`src/hooks/scanner`), same pattern as Receiving.
- Trailer placard barcode becomes an operational key: scanning it anywhere in
  the yard opens that visit.
- Mobile yard marshal surface at `/warehouse-app/yard/marshal` — touch-sized
  queue of assigned yard-move tasks, scan trailer, scan destination slot,
  confirm. Gate Console gets a responsive touch layout for handhelds.
- Slot labels carry a scannable slot code so relocation is confirmed by scan,
  not by typing.

## 5. Phase 7 — Warehouse and dispatch integration

- Visit contents panel: inbound ASN/receiving sessions and outbound loading
  manifests linked to the visit, read live.
- Load-readiness signal in the Control Tower and flow board: a trailer shows
  "ready to depart" the moment its blockers clear, driven by the existing
  blockers function plus realtime, so clearance is anticipated not discovered.
- Dispatch surfaces the yard position of each outbound manifest's trailer.

## 6. Phase 8 — Guardrails, docs, cleanup

- Extend `wms-phase9.test.ts`: yard tasks only via RPC, no scanner bypass in
  yard pages, marshal route/nav wiring, no duplicate relocate paths.
- Update ADR 0086 with the execution/hardware layer; note superseded parts.
- Remove any transitional code paths so exactly one relocate and one departure
  path remain.

## 7. Technical notes

- All new writes are `SECURITY DEFINER` RPCs emitting `warehouse.yard.*` events
  to `business_event_outbox`, matching the existing idempotency key scheme.
- New tables get GRANTs plus business-scoped RLS in the same migration.
- No stock effect: the yard stays a pre-inventory layer.
- Verification per phase: `tsgo --noEmit`, targeted vitest, live DB read-back,
  and an authenticated browser pass over the full lifecycle (the one check the
  previous engineer could not complete).
