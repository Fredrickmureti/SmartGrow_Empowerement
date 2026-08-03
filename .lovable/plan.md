# Cycle Count Subsystem — Enterprise Remediation Plan

Authoritative status for the Cycle Count architecture programme
(ADR 0106 — "Cycle counting: one count engine, Inventory-owned").

**Currently active phase:** Phase 7 — complete. Next up: Phase 8.
**Last updated:** 2026-08-03

---

## Architecture verdict (baseline audit)

| Subsystem | Verdict at audit | Status now |
|---|---|---|
| Canonical stock ownership | Enterprise-grade | Held |
| Scan pipeline / identity | Enterprise-grade | Held |
| Two competing count engines | Architecturally insufficient | Fixed (Phase 1) |
| Tolerance policy | Architecturally insufficient | Fixed (Phase 2) |
| Approval of differences | Architecturally insufficient | Fixed (Phase 1–2) |
| Blind counting | Architecturally insufficient | Fixed (Phase 2, 4, 5) |
| Reason codes | Architecturally insufficient | Fixed (Phase 2, 4) |
| Recounts | Architecturally insufficient | Fixed (Phase 2, 4) |
| Task orchestration | Architecturally insufficient | Fixed (Phase 3, 7) |
| Event-triggered counts | Architecturally insufficient | Fixed (Phase 3, 7) |
| Branch isolation on count data | Needs improvement | Fixed (Phase 6) |
| Count performance / accuracy KPIs | Needs improvement | **Pending (Phase 8)** |

---

## Completed and verified

### Phase 1 — One ledger path (done)
- `physical_count_freeze_scoped` — scoped snapshot of only the bins/products in scope.
- `create_count_session` bridges every session to a canonical Inventory count document.
- `post_count_session` hands off to the Inventory approval → adjustment → JE path;
  the warehouse no longer touches stock.

### Phase 2 — Control plane (done)
- Schema: `is_blind`, `recount_round`, `recount_of_line_id`, `variance_reason`
  (enum `wms_count_variance_reason`), `tolerance_outcome`.
- `evaluate_count_tolerance` — server-side policy evaluation.
- `record_count` returns `within_tolerance` / `recount_required` / `approval_required`
  and masks expected quantities in blind mode.
- Submission rejected server-side when a non-zero difference has no reason code.

### Phase 3 — Task orchestration, scheduling, event triggers (done)
- `create_count_session_as` (actor-explicit) emits one `wms_tasks` row of type `count`
  per bin, optionally pre-assigned.
- `cycle_count_schedules.execution_mode` ('warehouse' | 'inventory') + `is_blind`.
- `wms_count_triggers` table + outbox-driven evaluation with per-bin cooldown.

### Phase 4 — Desktop wiring (done)
- `useCountLines` (`get_count_lines`) is the only sanctioned read seam.
- `CountSession` — blind UI, tolerance badges, scan-to-line resolution, recount rounds.
- `CountReview` — mandatory reason codes before submission.
- `CycleCountPlanner` — blind toggle + operator assignment.

### Phase 5 — Mobile scan-first loop (done)
- `MobileCount` on the same read seam, blind masking, offline-queued tolerance outcomes.

### Phase 6 — Access control (done)
- Branch-gated RLS on `wms_count_sessions`, `wms_count_lines`, `wms_count_triggers`.

### Phase 7 — Close the count-work loop (done, this iteration)
- DB trigger `sync_count_task_for_line` — a bin's count task moves to `in_progress`
  on first capture and `done` when every line in that bin is counted. Count work
  closes on **evidence**, never on an operator clicking "complete".
- DB trigger `close_count_tasks_on_session_state` — posting a session closes remaining
  count tasks; cancelling one cancels them with a reason. No orphaned queue work.
- `get_count_task_target(task_id)` — resolves a claimed count task to its session/bin
  without exposing `wms_count_lines` (blind counting preserved).
- `MobileNextTask` — claim-next deep-links count tasks straight to their session;
  fixed the capture-route map, which pointed at the non-existent `/warehouse/*` base
  instead of `/warehouse-app/*` (every route in that map was dead).
- `OperatorTasks` — count tasks expose "open count" and can no longer be hand-completed.
- `CountTriggers` page (`/warehouse-app/counts/automation`) — admin surface for the
  event-trigger rules created in Phase 3, which until now had no UI.
- Architecture guard extended: no hand-completion of count tasks, automation surface exists.

Verification for Phase 7: `tsgo --noEmit` clean; `cycle-count-integrity.test.ts` (7 tests)
and `wms-phase4c.test.ts` green; migration applied successfully.

---

## Pending

### Phase 8 — Count performance & accuracy analytics (next)
The only subsystem still rated "needs improvement". Reference systems (SAP EWM
count analytics, Manhattan labour/accuracy reporting) treat count accuracy as a
first-class KPI feeding ABC re-classification.

Scope:
1. `wms_count_accuracy` reporting function (SECURITY DEFINER, branch-gated) returning
   per-warehouse/per-period: lines counted, lines with variance, absolute and net
   variance value, accuracy %, average count duration, recount rate, variance
   reason mix.
2. Per-operator accuracy and throughput derived from `counted_by` / task timestamps.
3. A supervisor analytics section on `SupervisorDashboard` (or a `CountAnalytics`
   page) rendering those KPIs — read via RPC only, never off `wms_count_lines`.
4. Feed accuracy back into scheduling: bins/products with repeated variance get a
   higher count frequency (ABC re-classification input on `cycle_count_schedules`).
5. Extend the architecture guard with the analytics read seam.

### Phase 9 — Backlog (not started)
- Count-by-license-plate (LPN-level counting) alongside bin/product counting.
- Serial-controlled count reconciliation against the serial register.
- Scheduled-count SLA breach alerting through the exceptions inbox.

---

## Instructions for the next agent

1. **Verify before you build.** Confirm Phase 7 actually holds:
   - `sync_count_task_for_line` and `close_count_tasks_on_session_state` exist and are
     attached as triggers; open a session, count a bin, confirm its `wms_tasks` row
     reaches `done`; post the session and confirm no `count` task is left open.
   - `get_count_task_target` returns the session for a count task and denies
     cross-business access.
   - `/warehouse-app/counts/automation` renders, and rules save/toggle/delete.
   - `bunx vitest run src/test/architecture/cycle-count-integrity.test.ts` is green
     and `tsgo --noEmit` is clean.
2. If any of the above fails, fix it before starting new work.
3. Then resume at **Phase 8** above — do not jump to Phase 9 or to unrelated
   warehouse subsystems.
4. Keep every invariant in ADR 0106 intact: one ledger path, `get_count_lines` as the
   only read seam, server-evaluated tolerance, mandatory reason codes, queued count work.
5. Update this file at the end of each phase: what is done and verified, what is
   pending, which phase is active, what comes next.
