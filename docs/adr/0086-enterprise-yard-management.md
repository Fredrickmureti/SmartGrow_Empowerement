# ADR 0086 — Enterprise Yard & Trailer Management

**Status:** Accepted (2026-08-03) · **Supersedes:** the operational half of
ADR 0080 (WMS Yard & Trailer Management) · **Complements:** 0076 (event
fabric), 0079/0080 (Inventory vs Warehouse split)

## Context — audit findings

ADR 0080 gave us tables (`wms_yard_slots`, `wms_trailer_visits`) and three
RPCs. An architecture audit of the shipped module against enterprise
YMS behaviour (SAP Yard Logistics, Manhattan YM, Blue Yonder, Körber)
found the module was a CRUD board, not a yard management system:

1. **Two parallel front doors.** `check_in_trailer`/`depart_trailer`
   (raw) and `gate_check_in`/`gate_exit` (audited, writing
   `wms_gate_events`) both existed, and the UI used the raw pair — so the
   chain of custody was empty in practice.
2. **Trailer was a string.** `trailer_ref` free text meant no fleet
   record, no per-unit visit history, no capacity or ownership.
3. **No movement history.** Slot occupancy was overwritten in place; the
   question "where has this trailer been since it arrived?" was
   unanswerable.
4. **No manual relocation.** Trailers could only be auto-parked at
   check-in. Yard jockey moves were invisible to the system.
5. **Unsafe departure.** `depart_trailer` did not check for open loading
   manifests or receiving sessions — a trailer could leave mid-load.
6. **Blind map.** Zone and capacity data existed but the UI ignored it,
   rendering a flat list. No dwell ageing, no occupancy, no KPIs.

## Decision

### Data

- **`wms_trailers`** — trailer master (code, type, ownership, carrier,
  length, capacity). Business-scoped, RLS, ordinary CRUD.
  `gate_check_in` resolves or creates the row, so the register is
  self-populating and `wms_trailer_visits.trailer_id` is always set.
- **`wms_yard_moves`** — append-only physical movement ledger: every
  park, relocate, dock assignment, dock release, departure and no-show,
  with from/to slot, from/to dock and status delta. RPC-only writes.
- **`wms_trailer_visits`** gains `trailer_id`, `departure_approved_at`
  and `departure_override_reason`.

### Transitions

Every transition is a `SECURITY DEFINER` RPC that logs a yard move and
emits a `warehouse.yard.*` business event (ADR 0076 outbox, idempotency
key `wms.trailer_visit:<id>:<status>`):

```text
gate_check_in ──► arrived ──► (auto-park) ──► in_yard
       │                         │  ▲
  gate_approve            relocate_trailer
       │                         │  │
       ▼                  assign_trailer_to_dock
   mark_trailer_no_show          ▼  │
                              at_dock ──release_trailer_from_dock──┘
                                 │
                    approve_trailer_departure  ← trailer_departure_blockers
                                 │
                             gate_exit ──► departed
```

- `trailer_departure_blockers(visit_id)` returns open loading manifests
  and receiving sessions. `approve_trailer_departure` refuses to clear a
  trailer while blockers exist unless a supervisor supplies an override
  reason, which is persisted on the visit.
- `gate_exit` requires prior clearance and computes dwell server-side.
- The raw `check_in_trailer` / `depart_trailer` primitives remain as
  internals of the gate wrappers; a guard test bans them from the UI.

### Surfaces

| Surface | Route | Audience |
|---|---|---|
| Yard Control Tower | `/warehouse-app/yard` | Supervisor — KPI strip, zoned yard map with drag-to-relocate, flow board with drag-to-dock, visit log |
| Gate Console | `/warehouse-app/yard/gate` | Guard house — expected today, awaiting clearance, cleared to leave; touch-sized |
| Trailer Register | `/warehouse-app/yard/trailers` | Master data — fleet, capacity, per-unit visit history |
| Yard Marshal | `/warehouse-app/yard/marshal` | Jockey handheld — scan-led claim and drop confirmation |

All three read one live dataset through `src/features/warehouse/yard/`
(`yardModel.ts` vocabulary, `useYard.ts` data layer) and are event-driven
via `useWmsRealtimeSync` — no polling.

### Execution layer — jockey work orders (Phase 5)

A supervisor's drag is an *intent*, not a physical move. `request_yard_move`
places that intent on the shared `wms_tasks` fabric as a `yard_move` task
(payload: visit, trailer ref, from/to slot and dock) so it is dispatchable,
claimable and measurable like every other warehouse task.

- `request_yard_move(visit, to_slot, to_dock, priority, notes)` → task row,
  emits `warehouse.yard.move_requested` (idempotency key includes the task id
  so repeated requests are distinct events).
- `complete_yard_move(task, confirmed_code)` validates the scanned code
  **server-side** against the expected slot/dock and then calls
  `relocate_trailer` / `assign_trailer_to_dock`, so the physical ledger and
  the visit state machine stay the single source of truth.
- `cancel_yard_move(task, reason)` closes the order without moving anything.

The control tower keeps a "dispatch move to jockey" toggle (default on);
turning it off restores the direct supervisor relocate for exception handling.

### Handheld execution — Yard Marshal (Phase 6)

`/warehouse-app/yard/marshal` is the jockey's surface: mobile-first, scan-led,
one task at a time. The jockey scans the trailer placard (`yard.trailer`
intent) to claim the order and scans the destination slot or dock label
(`yard.slot`) to confirm the drop. Confirmation is verified in
`complete_yard_move`, never compared in the client, so a wrong drop is
rejected by the database. Scan feedback (audio/haptic) uses the shared
`useWmsScanIntent` bus, identical to receiving, picking and packing.

### Trailer contents & load readiness (Phase 7)

The yard must know what is inside the box. The read-only view
`wms_trailer_visit_load_summary` (security invoker) joins each visit to:

- outbound `wms_loading_manifests` (+ `wms_manifest_cartons` counts, earliest
  planned departure, open manifests), and
- inbound `wms_receiving_sessions` via the shared appointment, with
  expected/received/damaged quantities from `wms_receiving_session_progress`.

It derives a `readiness` signal — `receiving` → `loading` → `ready` → `empty`
— surfaced on the trailer drawer. The view is *read-only by construction*:
manifest and receiving data stay owned by the outbound/inbound modules, and
departure control still runs through `trailer_departure_blockers`. Realtime
invalidation for `wms_loading_manifests` and `wms_receiving_sessions` keeps
the signal live.

## Consequences

- Dwell, on-time, occupancy and seal integrity are computable from
  `wms_trailer_visits` + `wms_yard_moves`; detention exposure has a
  source of truth for Phase 11 (3PL billing).
- The gate produces a complete chain of custody for every visit.
- Departure is a controlled, auditable decision rather than a button.
- Guard test `src/test/architecture/wms-phase9.test.ts` enforces
  RPC-only visit/move writes, the gate-only transition rule, the single
  master-data writer, and route/nav/realtime wiring.

## Non-goals

- Gate camera/OCR ingest (RPCs already accept the captured fields).
- Detention *billing* rules — Phase 11 tariffs.
- Appointment planning changes: `wms_dock_appointments` remains the
  planned view and its overlap constraint is untouched.
- No stock effect. The yard remains a pre-inventory layer.
- Trailer *content* modelling (item-level ASN inside a trailer) stays with
  inbound shipments; the yard only reads the aggregated readiness view.
