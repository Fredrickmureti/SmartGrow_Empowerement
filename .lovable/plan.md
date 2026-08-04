# Operator Task Execution Engine — Authoritative Project Status

**Domain:** Warehouse operator task execution (generation → assignment → claim → execute → complete → audit)
**Last updated:** 2026-08-04
**Currently active phase:** Phase 4 — Generation coverage completion (partially delivered)
**Next milestone:** Phase 4.3 — reservation-consistent wave release, then Phase 5 — supervisor release console

---

## Verdict recap (why this work exists)

The Operator Tasks module was **not** a CRUD list — it already had a guarded FSM (`wms_transition_task`), `SKIP LOCKED` claiming, optimistic locking via `row_version`, and lease heartbeats. It was, however, missing four things that separate a task list from a warehouse execution engine: durable lease recovery, a real execution ledger, a single canonical state vocabulary, and automatic work generation. Those are the phases below.

Architectural rule for this domain: **extend the existing engine, never bypass it.** All state change flows through `wms_transition_task`. No direct `UPDATE` on state columns from the client. No per-screen private task queues.

---

## Phase 1 — Execution ledger (audit trail) — ✅ COMPLETE & VERIFIED

- `wms_task_events` created: append-only, org/business/branch/warehouse scoped, RLS enabled, GRANTs issued, immutability trigger rejecting `UPDATE`/`DELETE`.
- `trg_wms_tasks_log_event` on `wms_tasks` harvests execution context automatically: actor, device id, scanned barcode, quantity, from/to state, reason.
- `wms-task-events` added to the invalidation map in `useWmsRealtimeSync.ts`.
- `src/features/warehouse/tasks/TaskHistorySheet.tsx` renders the read-only timeline; mounted behind a **History** action in `src/pages/warehouse/OperatorTasks.tsx`.

**Verified:** table present, trigger installed, typecheck clean. Ledger currently holds 0 rows because `wms_tasks` is empty — expected, not a defect.

## Phase 2 — Lease recovery / stranded work — ✅ COMPLETE & VERIFIED

- `wms_task_reap_expired` previously reaped only `claimed`. It now recovers `claimed`, `in_progress`, `paused` and `resumed` tasks whose lease heartbeat has expired, writing a reap reason to the ledger.
- Index `idx_wms_tasks_claim_lookup` widened to cover both `pending` and `available`, so reaped work is immediately re-claimable.

**Verified:** function body inspected in the live database; recovery states confirmed.

## Phase 3 — Canonical state vocabulary — ✅ COMPLETE & VERIFIED

- Retired `assigned` → `claimed` and `done` → `completed` everywhere.
- Write guard trigger rejects legacy state literals on write; `UPDATE` on state-critical columns revoked from `authenticated`.
- Frontend swept: `topics.ts` (union narrowed, `TASK_OPEN_STATES` / `TASK_HELD_STATES` introduced), `PickList`, `PackStation`, `MobilePutaway`, `MobilePick`, `MobilePack`, `MobileHome`, `PutawayQueue`, `useMyShift`, `yardModel`, `useWmsRealtimeSync`, `OperatorTasks` (`STATE_TONE`).
- Database swept: nine RPCs still writing retired literals were rewritten programmatically.

**Verified:** zero functions touching `wms_tasks` contain legacy literals. The two remaining repository-wide hits (`wms_assign_exception`, `wms_sscc_allocate`) belong to other domains and are unrelated to task state.

## Phase 4 — Automatic work generation — 🟡 ACTIVE (2 of 3 done)

**4.1 QC as first-class tasks — ✅ COMPLETE.** Triggers on `wms_qc_inspections` generate a `qc` task on open and finalize it (complete or cancel) when the inspection reaches a terminal state. QC work now lives in the unified operator queue instead of a private screen.

**4.2 Auto-wave for sales-order picks — ✅ COMPLETE.** `wms_wave_policies` (per-warehouse configuration) created and seeded; `wms_enqueue_order_for_wave` plus a trigger on `stock_reservations` automatically place sales-order allocations into a **draft** wave. Chosen behaviour, per decision: auto-wave with **manual release** — allocation never auto-dispatches operator work.

**4.3 Reservation-consistent wave release — ⛔ PENDING (immediate next work).**
`release_pick_wave` and the auto-wave enqueue path do not agree on stock-reservation handling. Releasing a wave can therefore emit pick tasks whose reservations do not match what waving assumed. This is the one known incoherence in the generation path and must be closed before Phase 5, otherwise the release console would ship on top of an inconsistent write model.

Required: reconcile reservation ownership between `stock_reservations`, the enqueue trigger and `release_pick_wave`; make release idempotent and transactional (all lines or none); log release to `wms_task_events`; ensure a cancelled/re-planned wave releases its reservations.

## Phase 5 — Supervisor release console — ⛔ NOT STARTED

Because waving is now automatic but release is manual, supervisors need a surface to see draft waves, inspect their lines and coverage, release or cancel them, and observe the resulting tasks. Depends on Phase 4.3 being correct.

## Phase 6 — Generation coverage for remaining task types — ⛔ NOT STARTED

Audit each remaining `wms_task_type` for an automatic generator; the types still created only by hand get one, or are explicitly documented as human-initiated by design.

## Phase 7 — Execution telemetry — ⛔ NOT STARTED

Derive operator throughput, dwell time per state, reap/abandon rate and lease-loss rate from `wms_task_events`. No new counters or denormalised columns — the ledger is the source.

---

## Instructions for the next agent

**Do verification before you build anything.** Do not start Phase 4.3 until the checks below pass, and do not pick up unrelated warehouse work.

1. **Verify Phases 1–3 against the live database, not against this document.**
   - `wms_task_events` exists with RLS enabled, GRANTs for `authenticated` and `service_role`, and an immutability trigger that actually rejects `UPDATE` and `DELETE`.
   - `trg_wms_tasks_log_event` fires on every state transition and captures actor, device, barcode and quantity — insert a task, transition it through the full lifecycle, read the ledger, then clean up.
   - `wms_task_reap_expired` recovers `claimed`, `in_progress`, `paused`, `resumed`; the reaped task is genuinely re-claimable afterwards.
   - No function touching `wms_tasks` writes `'assigned'` or `'done'`; the write guard rejects them.
   - `UPDATE` on state-critical `wms_tasks` columns is not granted to `authenticated`.
2. **Verify Phase 4.1 and 4.2 end to end.** Open a QC inspection → a `qc` task appears in the queue; finalize it → the task reaches a terminal state. Create a sales-order allocation → it lands in a draft wave and no operator task is emitted until release.
3. **Run the Supabase linter and a typecheck** (`tsgo`), and confirm RLS coverage on the new tables.
4. **If any check fails, fix that phase first.** Report the discrepancy plainly and correct it before advancing — a failed earlier phase outranks new feature work.
5. **Only then implement Phase 4.3** exactly as scoped above, bringing it to a production-ready state (migration + RPC + UI wiring + verification) before touching Phase 5.
6. **Update this file** as you go: move completed items to ✅ with what was verified, keep the active phase marker accurate, and leave the next agent the same kind of handoff.

**Do not:** jump to Phase 6 or 7 early, leave Phase 4.3 half-migrated, add a parallel task table or a per-screen task queue, bypass `wms_transition_task`, or reintroduce `assigned`/`done`.
