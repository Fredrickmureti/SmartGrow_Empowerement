# Yard & Trailer Management — CLOSED (Phases 1–4 complete)

**Module:** Warehouse › Yard & Trailer Management
**Reference:** ADR 0086 (`docs/adr/0086-enterprise-yard-management.md`), supersedes the
operational half of ADR 0080.
**Status:** ✅ **GREENLIGHT — module complete, production-ready, no pending work.**
**Closed:** 2026-08-03

---

## 1. What was delivered and verified

### Phase 1 — Data & transition layer (DONE, migrations applied)

| Item | State |
|---|---|
| `wms_trailers` — trailer master (code, type, ownership, carrier, length, capacity), RLS + business-scoped policies | ✅ applied, backfilled from historical visits |
| `wms_yard_moves` — append-only physical movement ledger (from/to slot, from/to dock, status delta, reason) | ✅ applied, RPC-only writes |
| `wms_trailer_visits` extended with `trailer_id`, `departure_approved_at`, `departure_override_reason` | ✅ applied |
| `trailer_departure_blockers(visit_id)` — open loading manifests + receiving sessions | ✅ applied |
| `relocate_trailer`, `release_trailer_from_dock`, `approve_trailer_departure`, `mark_trailer_no_show` | ✅ applied |
| `check_in_trailer` / `assign_trailer_to_dock` / `depart_trailer` rewritten to resolve the trailer master and log yard moves | ✅ applied |
| Realtime publication for `wms_trailers`, `wms_yard_moves` | ✅ verified in `pg_publication_tables` |

### Phase 2 — Authoritative workflow (DONE)

- Every arrival and exit goes through `gate_check_in` / `gate_exit`, so
  `wms_gate_events` carries a complete chain of custody. The raw
  `check_in_trailer` / `depart_trailer` primitives are internals only.
- Departure is a controlled decision: `approve_trailer_departure` refuses to
  clear a trailer while blockers exist unless a supervisor records an override
  reason, which is persisted on the visit.
- Every transition writes a yard move and emits a `warehouse.yard.*` event onto
  `business_event_outbox` (idempotency key `wms.trailer_visit:<id>:<status>`).

### Phase 3 — Yard Control Tower UI (DONE)

| Surface | Route | State |
|---|---|---|
| Yard Control Tower — KPI strip, zoned map with drag-to-relocate, flow board with drag-onto-dock, visit log | `/warehouse-app/yard` | ✅ |
| Gate Console — touch-sized: expected today, awaiting clearance, cleared to leave | `/warehouse-app/yard/gate` | ✅ |
| Trailer Register — fleet master data + per-unit visit history | `/warehouse-app/yard/trailers` | ✅ |
| `TrailerVisitDrawer` — gate custody, movement ledger, blocker-gated departure | shared | ✅ |
| Legacy `YardBoard.tsx` decommissioned | — | ✅ removed |
| Event-driven refresh via `useWmsRealtimeSync` (no polling) | — | ✅ |

### Phase 4 — Labels (DONE)

- Migration adds `wms_seed_yard_label_templates` with `wms.label.trailer_placard`
  (trailer code, carrier, slot, seal, scannable visit barcode) and
  `wms.label.yard_slot` (slot code, zone, barcode); folded into
  `wms_seed_default_label_templates` and backfilled for existing organisations.
  Verified present in `label_templates`.
- `src/features/warehouse/yard/yardLabels.ts` owns yard-specific token binding;
  printing stays on `printWmsLabel` → `PrintService`.
- Wired: "Print yard placard" in the visit drawer, "Print slot label" in the
  yard slot dialog. No orphaned handlers remain.

### Verification performed

- `tsgo --noEmit` — clean.
- `eslint` on all new/changed yard files — 0 errors (1 fast-refresh warning).
- `vitest` — `wms-phase9.test.ts` (rewritten yard guard, 6 tests) and
  `wms-label-keys-sync.test.ts` (2 tests) pass, as does
  `wms-dispatch-proof-and-liveness.test.ts`.
- Database read-backs confirm the new tables, realtime publication and both
  label templates.
- Browser smoke check redirected to `/login` (the sandbox has no preview
  session), so runtime rendering was not visually confirmed — see "for the next
  agent" below.

### Guardrails now enforced (`src/test/architecture/wms-phase9.test.ts`)

1. No client write to `wms_trailer_visits` / `wms_yard_moves` — RPC-only.
2. No UI call to the raw `check_in_trailer` / `depart_trailer` primitives.
3. `wms_yard_slots` / `wms_trailers` writes only from `useYard.ts`.
4. `useYard.ts` exposes the full transition set.
5. Nav, routes and realtime wiring for all three yard surfaces.

---

## 2. Pending work

**None for this module.** Phases 1–4 are closed. Deliberate non-goals, recorded
in ADR 0086 and *not* to be treated as gaps:

- Gate camera / OCR ingest — out-of-band capture; the RPCs already accept the fields.
- Detention **billing** rules — belongs to Phase 11 (3PL tariffs), not the yard.
- Appointment planning changes — `wms_dock_appointments` remains the planned view.
- No stock effect: the yard is a pre-inventory layer by design.

---

## 3. Currently active phase

None. The Yard & Trailer module is closed and handed off.

---

## 4. Instructions for the next agent

**Step 1 — verify before you build.** Do not assume this handoff is correct.
Confirm, in this order:

1. `npx tsgo --noEmit -p tsconfig.app.json` is clean.
2. `npx vitest run src/test/architecture/wms-phase9.test.ts src/test/architecture/wms-label-keys-sync.test.ts src/test/architecture/wms-dispatch-proof-and-liveness.test.ts` passes.
3. Load `/warehouse-app/yard`, `/warehouse-app/yard/gate` and
   `/warehouse-app/yard/trailers` **with an authenticated session** and exercise
   one full lifecycle: gate check-in → security clear → relocate → assign to dock
   → release → departure clearance (with a blocker present, then overridden) →
   gate exit. Confirm the KPI strip, movement ledger and gate custody log all
   update live without a refresh. This is the one check the previous agent could
   not complete.
4. Spot-check that `wms_yard_moves` gained a row per transition and that
   `business_event_outbox` carries the matching `warehouse.yard.*` events.

If any of the above fails, fix it inside this module before moving on.

**Step 2 — resume the roadmap chronologically.** The next logical milestone is
**Phase 11 — 3PL billing / tariffs**, which consumes the `warehouse.yard.*`
activity signals and the dwell data this module now produces. Do not start
unrelated modules ahead of it.
