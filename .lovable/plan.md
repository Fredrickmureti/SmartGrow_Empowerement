# Yard & Trailer Management — Architecture Audit and Redesign

## Audit findings (verified against the codebase and live database)

**What exists and is sound**

- `wms_trailer_visits` is RPC-write-only with a real state machine (`arrived → in_yard → at_dock → departed`, plus `no_show`), business-scoped access checks inside every RPC, server-computed dwell, and `business_event_outbox` emission via `emit_yard_event`.
- `wms_yard_slots` already carries `zone_kind`, `sequence`, `capacity`, `slot_type` — and `check_in_trailer` uses them to auto-park by zone priority (parking bay → waiting lane → staging → overflow).
- A gate layer already exists: `wms_gate_events` plus `gate_check_in` (QR-token appointment binding, identity capture, seal verification), `gate_approve`, `gate_exit`.
- Appointment lifecycle is wired both ways: check-in promotes `scheduled → arrived`, dock assignment → `in_progress`, departure → `completed`.
- Dispatch is linked: `wms_loading_manifests.trailer_visit_id`; Returns carry `trailer_visit_id`.

**The real problems**

1. **Two parallel implementations of the same workflow.** `src/pages/warehouse/YardBoard.tsx` calls the raw `check_in_trailer` / `depart_trailer` RPCs directly, while `src/features/warehouse/dock/useDockScheduling.ts` calls the `gate_*` wrappers. Trailers checked in from the Yard board therefore produce **no gate event trail** — no identity verification, no seal verification record, no security approval, no QR appointment binding. Two doors into the same state machine, only one of them audited.
2. **Departure is not gated by work-in-progress.** `depart_trailer` checks only that the visit is not already departed. A trailer can be released while its loading manifest is open or its receiving session is unclosed. There is no load-readiness or departure-approval step anywhere.
3. **Yard movement is invisible.** Parking happens implicitly inside check-in; dock assignment silently frees the slot. There is no relocate, no re-queue, no manual park, and no movement history — only the current `yard_slot_id`. Dwell-by-stage (gate → yard → dock) cannot be computed.
4. **Trailers are not first-class.** `trailer_ref` is free text on both the appointment and the visit. No trailer identity, ownership, type, or cross-visit history. The same physical trailer cannot be traced across visits.
5. **The yard map ignores the model it sits on.** The board queries only `id, code, slot_type, status` and renders one flat grid — zones, staging, waiting lanes and overflow are invisible even though the data models them.
6. **No gate/yard mobile surface.** `qr_token`, `useWmsIdentityGate`, and the scan intent layer all exist, but there is no scan-first console for a gate officer or yard marshal. `MobileNextTask` covers picking tasks only.
7. **No yard labels.** `printWmsLabel` / `WMS_LABEL_KEY` exist for warehouse labels; trailer placards and yard-slot location labels are absent.
8. **No situational awareness.** The board is a table plus a slot grid. No dwell ageing, no overdue appointments, no dock occupancy, no carrier on-time signal, no departure-ready queue.

## What will be built

### One authoritative workflow

Every yard state transition goes through the gate-aware RPC layer. `YardBoard`'s direct `check_in_trailer` / `depart_trailer` calls are removed and replaced by `gate_check_in` / `gate_exit`, so every visit carries a complete gate audit chain regardless of which surface initiated it. The raw RPCs stay as internal building blocks only — callable from the wrappers, not from the UI. The Phase 9 architecture test is updated to assert the inverse of what it asserts today: pages must call `gate_*`, never the raw transitions.

### Backend (single migration)

- `wms_trailers` — trailer master: `code` (unique per business), type, ownership (own/carrier/customer), carrier link, capacity, active flag. `wms_trailer_visits.trailer_id` added and resolved from `trailer_ref` on check-in (auto-created on first sighting), preserving the free-text field for legacy rows.
- `wms_yard_moves` — one row per physical movement: from/to slot or dock, reason (`park`, `relocate`, `queue`, `to_dock`, `release`), actor, timestamp. Written by every transition RPC, so stage-level dwell becomes computable.
- `relocate_trailer(visit_id, slot_id)` — explicit park/relocate/re-queue, with slot occupancy locking.
- `release_trailer_from_dock(visit_id, slot_id?)` — dock → yard without departing.
- `approve_trailer_departure(visit_id)` and a guard inside `gate_exit`: refuse departure while any linked loading manifest is not dispatched or any receiving session is not closed, unless an explicit override reason is supplied (recorded as a gate event).
- All new RPCs emit `warehouse.yard.*` events with the existing `wms.trailer_visit:<id>:<state>` idempotency shape, and log gate events where a gate officer is involved.

### Frontend — Yard Control Tower

`YardBoard.tsx` is replaced by a feature module under `src/features/warehouse/yard/` (hooks + components) with a thin page shell, matching the structure already used by `dock/` and `returns/`:

- **KPI strip** — trailers on site, average dwell, longest dwell, docks occupied, overdue appointments, departure-ready count.
- **Yard map** — grouped by `zone_kind` (parking bays, waiting lanes, inbound/outbound staging, overflow), colour-coded by occupancy, showing occupant trailer and dwell age; drag a trailer between slots to relocate.
- **Live lanes board** — Kanban-style columns following the real lifecycle: At gate → In yard → At dock → Ready to depart → Departed today, with dwell-ageing colour bands.
- **Trailer visit drawer** — full chain of custody: appointment, gate events, seals, yard moves, dock, linked manifests/receiving sessions/returns, with the actions valid for the current state.
- **Gate console** (`/warehouse-app/yard/gate`) — scan-first, mobile-shaped: scan the appointment QR or type a trailer, capture driver identity and seal, approve/reject, check in or exit. Uses the existing scanning and identity-gate primitives.
- **Trailer master** (`/warehouse-app/yard/trailers`) — list plus per-trailer visit history.
- Trailer placard and yard-slot labels routed through `printWmsLabel` with new label keys.

Real-time comes from the existing `useWmsRealtimeSync` channel; the new tables are added to the realtime publication and to the publication-sync test.

### Removals

`src/pages/warehouse/YardBoard.tsx` in its current form, its inline dialogs, and its direct raw-RPC calls are deleted — not kept as a fallback. `/warehouse-app/yard` points at the new control tower.

## Technical notes

- One migration adds `wms_trailers`, `wms_yard_moves`, `wms_trailer_visits.trailer_id`, the new RPCs, the departure guard, GRANTs, RLS (business-scoped, matching the existing `wms_*` pattern: `SELECT` to `authenticated`, writes via `SECURITY DEFINER` RPCs only), and realtime publication entries.
- No changes to Inventory-owned tables, valuation, quants, or movements — the yard stays a pre-inventory operational layer per ADR 0080.
- Existing appointment, dispatch, receiving and returns integrations are extended, not rewritten.
- New ADR `0086-yard-control-tower.md` records the single-door gate decision, the trailer master, and the movement ledger; ADR 0080 gets a superseding note.
- Architecture tests: updated Phase 9 guard (pages must use `gate_*`), plus a new guard that no UI file writes `wms_trailer_visits` or `wms_yard_moves` directly.

## Delivery order

1. Migration: trailer master, yard moves, relocate/release/approval RPCs, departure guard, realtime.
2. Feature module: hooks, models, event topics.
3. Control tower UI (map, lanes, KPI strip, visit drawer).
4. Gate console and trailer master pages, labels.
5. Delete the legacy board, update routes, update architecture tests, write the ADR.
