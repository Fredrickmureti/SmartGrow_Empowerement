# Operator Task Execution Engine — CLOSED

**Domain:** Warehouse operator task execution (generation → assignment → claim → execute → complete → audit)
**Closed:** 2026-08-04
**Status:** All phases (1–7) complete and verified. No active work remains under this plan.

---

## Verdict

The Operator Tasks module was never a CRUD list: it already had a guarded FSM
(`wms_transition_task`), `SKIP LOCKED` claiming, optimistic locking via
`row_version`, and lease heartbeats. What it lacked — durable lease recovery, a
real execution ledger, one canonical state vocabulary, and automatic work
generation — has now been built.

Architectural rule for this domain, still binding: **extend the engine, never
bypass it.** All task state change flows through `wms_transition_task`; no
direct client `UPDATE` on state columns; no per-screen private task queues.

---

## Phase 1 — Execution ledger — ✅ COMPLETE
`wms_task_events` (append-only, scoped, RLS + GRANTs, immutability trigger),
`trg_wms_tasks_log_event` capturing actor/device/barcode/quantity/from→to,
realtime invalidation, `TaskHistorySheet` timeline in Operator Tasks.

## Phase 2 — Lease recovery — ✅ COMPLETE
`wms_task_reap_expired` recovers `claimed`, `in_progress`, `paused`, `resumed`;
`idx_wms_tasks_claim_lookup` widened so reaped work is immediately re-claimable.

## Phase 3 — Canonical state vocabulary — ✅ COMPLETE
`assigned`→`claimed`, `done`→`completed` retired across DB and frontend; write
guard rejects legacy literals; state-column `UPDATE` revoked from
`authenticated`. Closing sweep removed the last legacy edges
(`assigned>claimed`, `assigned>in_progress`, `in_progress>done`) from
`wms_transition_task` itself.

## Phase 4 — Automatic work generation — ✅ COMPLETE
- **4.1 QC** — triggers on `wms_qc_inspections` open and finalize `qc` tasks.
- **4.2 Auto-wave** — `wms_wave_policies` + `wms_enqueue_order_for_wave` place
  sales-order allocations into **draft** waves. Allocation never auto-dispatches
  operator work; release stays manual by design.
- **4.3 Reservation-consistent release/cancel** — audit found four real defects
  and all were fixed:
  - double reservation on release → `_wms_consume_order_reservation` transfers
    ownership from the order to the wave atomically;
  - release race → `FOR UPDATE` locking plus idempotent no-op on re-release;
  - FSM bypass on cancel → all cancellation now routes through
    `wms_transition_task`;
  - stranded reservations → `_wms_unwind_cancelled_wave` releases wave
    reservations and restores unpicked demand to the sales order.
  Critically, the supervisor cancel button calls `wms_transition_wave`, which
  did none of this; that path now delegates to the same unwind, and
  `wms_transition_wave` refuses `→ released` so release can only happen through
  `release_pick_wave`.

## Phase 5 — Supervisor release console — ✅ COMPLETE
`DraftWaveConsole` (mounted in the Wave Planner) lists draft waves with order /
line / unit coverage, expandable line detail, Release (`useReleaseWave` →
`release_pick_wave`, reporting tasks created and short picks) and Cancel through
the aggregate FSM.

## Phase 6 — Generation coverage for all task types — ✅ COMPLETE
Every `wms_task_type` now has an automatic generator, or is human-initiated by
explicit design:

| Type | Generator |
| --- | --- |
| `putaway` | `receive_goods_to_wms`, `wms_post_return_dispositions` |
| `pick` | `release_pick_wave` |
| `pack` | **new** `trg_wms_pack_tasks_on_wave_state` — one pack task per sales order when a wave reaches `picked`; auto-completed on `packed` |
| `load` | **new** `trg_wms_load_tasks_on_manifest_state` — on manifest `loading`; auto-completed on `closed`/`dispatched`, cancelled on `cancelled`; also `wms_crossdock_confirm_staged` |
| `count` | `generate_due_cycle_counts` (scheduled), `create_count_session_as` |
| `replenish` | `plan_replenishment`, `_wms_maybe_enqueue_replen`, `wms_transition_replen_order` |
| `move` | `wms_crossdock_start_staging` |
| `qc` | `_wms_qc_task_on_open` |
| `yard_move` | `request_yard_move` — human-initiated by design (a marshal requests the move); duplicate open moves per visit are rejected |

Supporting primitives: `_wms_drive_task_to` walks a task to `completed` or
`cancelled` through legal FSM edges only, and `_wms_finalize_source_tasks`
closes every task attached to a source document. Wave cancellation now unwinds
**all** task types on the wave, not just picks.

## Phase 7 — Execution telemetry — ✅ COMPLETE
`wms_task_telemetry(warehouse, from, to)` derives everything from
`wms_task_events` — no counters, no denormalised columns: totals (events, tasks
touched, completed, cancelled, exceptions, active operators), per task type
(throughput, average wait to claim, average execution time, exception rate,
lease-loss/reap rate) and a per-operator leaderboard. Surfaced at
`/warehouse-app/telemetry` ("Execution telemetry" in the Warehouse nav) via
`useTaskTelemetry`.

---

## Verification performed

- Phases 1–3 checked against the live database (table, trigger, reaper body,
  grants, absence of legacy literals) rather than against this document.
- Wave release/cancel logic reviewed function-by-function in `pg_proc`; both
  cancel entry points confirmed to hit the shared unwind.
- Telemetry aggregation SQL executed standalone against the ledger.
- `tsgo --noEmit` clean; WMS architecture tests green
  (`wms-phase3`, `wms-phase5`, `wms-phase14`, `wms-no-direct-domain-rpc`,
  `wms-no-direct-state-writes`).

## Known, out of scope for this plan

Two pre-existing architecture test failures are unrelated to task execution and
belong to other domains: `wms-topic-catalog-sync` (two seeded
`warehouse.labour.*` topics not declared in `WMS_TOPIC`) and
`payroll-reports-no-legacy-columns`.

## If this domain is picked up again

Do not add a parallel task table, a per-screen task queue, or any direct
`UPDATE` on `wms_tasks.state`. New work types get a generator plus a terminal
finalizer, both routed through `wms_transition_task`, and their telemetry comes
free from the ledger.
