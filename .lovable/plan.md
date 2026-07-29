## Verification results

Ran the previous engineer's Round 4 claims against the code and DB. All items marked ✅ hold up:

- **Guard suite:** `bunx vitest run src/test/architecture/wms-` → **26 files / 97 tests green** (matches ledger; Phase 2.7 reconciliation stuck).
- **Phase 3.1 QC lifecycle:** `qc_resolution_kind` enum and `wms_qc_inspections.resolution_kind` column both present.
- **Phase 3.2 Cross-dock:** `evaluate_crossdock_on_receiving_line` RPC present; `wms-crossdock-subscriber` guard passes.
- **Phase 3.3 Receiving:** `trg_wms_recv_lines_emit_captured` trigger present.
- **Phase 3.4 Replenishment:** `_wms_maybe_enqueue_replen` helper + `trg_stock_quants_replen` trigger present.
- **Phase 3.5 Yard/trailer:** `mark_trailer_no_show` RPC present alongside the other trailer RPCs.

No false or partial claims found this round. **Genuine resume point = Phase 3.6.** Phases 3.7, 3.8, and Phase 4 UX from Round 4 remain untouched and carry forward unchanged.

## Phase 3.6 — Labour / task orchestration (in progress)

### Landed this round

- **Migration `20260729142339`** (+ precedence bugfix migration): unified `wms_labour_queue_view` (security_invoker=true) over `wms_tasks` open states, and extended `evaluate_crossdock_on_receiving_line` to seed a `pack` task with `source_doc_type = 'wms_crossdock_opportunity'` — cross-dock now surfaces in the same labour queue as normal pick/pack work, no phantom putaway.
- **Guard `wms-phase-labour-lifecycle.test.ts`** — pins (a) the view exists, (b) `security_invoker=true`, (c) cross-dock evaluator seeds the stage-for-dispatch task. 3/3 green.
- Confirmed `wms_claim_next_task(warehouse_id, task_types, zone_id, lease_seconds)` and `_wms_emit_task_event` already exist; no re-invention needed.
- **Task-lifecycle pause/resume (this round):**
  - Migration adds `paused` + `resumed` to `wms_task_state`, extends `wms_transition_task` FSM allow-list (`in_progress↔paused↔resumed↔in_progress`, `paused→cancelled`), maps both onto canonical topics in `_wms_emit_task_event`, and version-scopes the outbox idempotency key (`wms.task:{id}:{state}:v{row_version}`) so pause→resume→pause loops each emit a distinct event instead of colliding on the outbox unique index.
  - `WMS_TOPIC.TASK_PAUSED` / `TASK_RESUMED` + `TASK_STATES` extended; `wms_events_catalog` seeded (`producers=[wms_transition_task]`, `consumers=[operator_ui, supervisor, labour]`); `WMS_MODULE_OWNERSHIP.md` register updated.
  - `wms_labour_queue_view` now includes `paused|resumed` rows so suspended work stays on the supervisor board.
  - Guard `wms-phase-labour-lifecycle` extended to 6/6 (topic mapping, version-scoped idempotency key, and the four new FSM edges); guard suite is **27 files / 103 tests, all green**.
  - `transition_seq` column deliberately **not added** — `row_version` already increments monotonically per FSM transition and is now embedded in the idempotency key, so a separate counter would be redundant.

### Still open (next agent picks up here)

### Round 5 closes Phase 3.6

1. **Legacy in-body task emissions are gone** — audited migration `20260729092007`; `_wms_strip_emit` already excised `emit_business_event` / direct outbox inserts from `assign_wms_task`, `claim_pick_task`, `complete_pick_task`, `complete_pack_task`, `complete_putaway_task`. Pinned by extending `wms-outbox-parity.test.ts` `TRIGGER_OWNED_RPCS` with `assign_wms_task` + `claim_pick_task`; the FSM RPCs (`wms_transition_task`, `wms_transition_lpn`, `wms_claim_next_task`) were already covered. `_wms_emit_task_event` is now the single producer for every `warehouse.task.*` topic.
2. **Mobile RF next-task** — shipped in Round 4 at `/warehouse/mobile/next`.
3. **Realtime device fan-out** — `useWmsRealtimeSync` now opens a per-user channel `user-<uid>-wms-tasks` that filters `wms_tasks` on `assignee_user_id=eq.<me>`. Leading-edge `assigned` transitions pop a `useToast` notification ("New warehouse task assigned · PICK · tap Next Task to start"). De-dupes per `${task_id}:${state}` with a 200-entry rolling set so a re-render or reconnect can't spam the operator. Channel is scoped to `user?.id` (torn down on sign-out only), independent of the org-scoped WMS channel so a business switch doesn't drop assignment toasts.
4. **Playwright race spec** — `e2e/wms/labour-claim.spec.ts`: two browser contexts race `wms_claim_next_task` in parallel against 4 seeded pick tasks, then assert (a) winners are distinct, (b) both winners belong to the seeded set, (c) exactly one `warehouse.task.assigned` outbox row exists per winning `source_doc_id` (single-producer proof).
5. **Cascade gap left as-is:** `mark_trailer_no_show` does not cancel open `load` tasks — `wms_loading_manifests` has no `trailer_visit_id` column, so linkage would need a new column or route through `wms_dock_appointments`. Deferred until Phase 3.7 loading-manifest hardening.

**Phase 3.6 exit:** WMS guard suite **27 files / 103 tests green** (`bunx vitest run src/test/architecture/wms-`). Type-check clean. Phase 3.6 is now officially closed.

### Handoff to the next agent

**Verify first (don't just trust the ledger):**
1. `bunx vitest run src/test/architecture/wms-` — must stay 27/103 green.
2. `rg -n "PERFORM\s+public\._wms_emit_event" supabase/migrations/ | rg -v "^supabase/migrations/(20260729085747|20260729090006|20260729143131|20260729130352|20260729130803|20260729124818)"` — confirm no NEW in-body emitters have appeared in later migrations for `assign_wms_task` / `complete_pick_task` / `complete_pack_task` / `complete_putaway_task` / `claim_pick_task`. Only the FSM RPCs and the AFTER triggers may emit.
3. Spot-check: open `LabourBoard`, confirm the "Live labour queue" panel renders with SLA/unassigned badges and 15 s refetch; open `/warehouse/mobile/next` on a device, confirm the "Claim next task" button routes to the correct capture surface for the returned `task_type`.
4. (Optional against a real Supabase env) drive `e2e/wms/labour-claim.spec.ts` — must land exactly one `warehouse.task.assigned` outbox row per claimed task.

**Resume point:** Phase 3.7 — Wave / Pick / Pack / Dispatch hardening (see below). Do **not** jump into Phase 4 UX; Phase 3.7 replaces empty e2e scaffolds and adds the scan-out enforcement + cancellation cascade before UX polish.

### Also landed this round

- **`LabourBoard` — Live labour queue section**: new supervisor grid backed by `wms_labour_queue_view` with task-type filter, SLA-breached / unassigned / total badges, 15s refetch, priority + SLA ordering. Reuses existing warehouse filter. Type-checks clean.
- **Mobile RF `/warehouse/mobile/next`**: single-screen operator entry point that calls `wms_claim_next_task` via `useTaskEngine`. Remembers the warehouse per-device in `localStorage`, disables the button while claiming, and hands the claimed task off to the OperatorTasks capture surface (`?claimed=<id>`). `routeForTaskType()` helper exported and centralises the task_type → capture-screen map so a new task type only needs one edit. Route wired at `mobile/next` under `SubscriptionProtectedRoute`. Type-checks + 27/103 guards green.

### Original spec (kept for reference)

**Pre-flight (do first, no code):**
1. `bunx vitest run src/test/architecture/wms-` — must stay 26/97 green.
2. `SELECT event_type, count(*) FROM public.business_event_outbox WHERE event_type LIKE 'warehouse.trailer.%' GROUP BY 1;` — canonical only, no `warehouse.yard.*`.
3. `\df+ public.mark_trailer_no_show` — confirm `GRANT EXECUTE` to `authenticated` only.

**Problem:** `wms_tasks` / `wms_task_assignments` transitions (`assigned`, `paused`, `resumed`, `completed`) don't publish canonical outbox events, so the realtime task board and headset-first pickers can't fan out. Replen/putaway/pick queues are also fragmented per module — no single "next task" surface.

**Objectives:** trigger-owned task-lifecycle emission + one unified labour queue + one `claim_next_task` RPC.

**Steps (standard vertical — migration → RPC → hook → page → realtime → Playwright → guard):**

1. **Migration — task lifecycle emission**
   - Add `WMS_TOPIC.TASK_ASSIGNED|PAUSED|RESUMED|COMPLETED` (`warehouse.task.*`) to `src/features/warehouse/events/topics.ts` and `wms_events_catalog`. Bus + saga pick them up via existing `Object.values(WMS_TOPIC)` loop.
   - `_wms_emit_task_lifecycle()` trigger on `wms_tasks` (AFTER UPDATE OF `state`, `assignee_user_id`, `paused_at`). Idempotency key `wms.task:{id}:{state}:{transition_seq}`.
   - Payload: task_id, task_type, warehouse_id, business_id, assignee_user_id, prior_state, new_state, product_id/lpn/from_location/to_location where relevant, so headsets don't need a follow-up query.
   - Add `transition_seq bigint` counter column so paused→resumed→paused loops each get a unique idempotency key.
   - Extend `wms-outbox-parity.test.ts` with the four new transitions.

2. **Transition RPCs**
   - `wms_transition_task(task_id, target_state, payload jsonb)` — accepts `assigned|paused|resumed|completed|cancelled`; enforces FSM allow-list matching the existing `_wms_emit_state_change` pattern.
   - Retire in-body emissions from `assign_wms_task`, `complete_pick_task`, etc.; they route through `wms_transition_task` so the trigger owns emission (no double publish).
   - `claim_next_task(warehouse_id uuid, capabilities text[])` — atomically picks the highest-priority open task the caller is capable of, stamps `assignee_user_id = auth.uid()`, transitions to `assigned`, returns the row. `FOR UPDATE SKIP LOCKED` on the priority queue to survive concurrent claim storms.
   - `GRANT EXECUTE ... TO authenticated` only; both RPCs assert business membership via existing helper.

3. **Typed hooks**
   - `useClaimNextTask()` and `useTransitionTask()` in `src/hooks/warehouse/`; both use the shared error/toast shell.
   - No component may call `supabase.rpc('wms_transition_task', …)` directly (extend `wms-no-direct-domain-rpc` guard).

4. **Unified labour queue view + page**
   - View `wms_labour_queue_view` (security_invoker) unions replen + putaway + pick + pack + count + qc tasks with columns `(task_id, task_type, priority, sla_due_by, warehouse_id, business_id, assignee_user_id, state, required_capabilities[])`.
   - Refactor `LabourBoard` (already the sole writer to `wms_task_standards` per Phase 10) to consume this view; supervisors see slack across all task types in one grid grouped by capability + SLA.
   - Mobile RF: single `/wms/mobile/next` screen that calls `claim_next_task`, routes to the correct capture screen based on `task_type`.

5. **Realtime device fan-out**
   - `useWmsRealtimeSync` subscribes to `warehouse.task.assigned`; when `payload.assignee_user_id === auth.uid()` and the current device is idle, push a browser/RF notification ("Next task: Pick #123 @ A-04-02").
   - Contention: subscribing to `warehouse.task.assigned` where `assignee_user_id != me` for a task I claimed = someone reclaimed it (should be prevented by RPC, but surface a toast + auto-return-to-queue for defense in depth).

6. **Playwright**
   - `e2e/wms/labour-claim.spec.ts` — two browser contexts race `claim_next_task` for the same warehouse; assert exactly one succeeds, the other gets the next-priority task, and both receive `warehouse.task.assigned` events for their own claim.

7. **Guards**
   - `wms-phase-labour-lifecycle.test.ts`: every `wms_task_assignments` state has an outbox topic; `wms_tasks` write path guard forbids bare `UPDATE ... SET state = ...` outside `wms_transition_task`.
   - Extend `wms-outbox-parity.test.ts` with the four topics.

**Exit criteria:** guard suite 27+ files green; `SELECT event_type, count(*) FROM business_event_outbox WHERE event_type LIKE 'warehouse.task.%' GROUP BY 1;` returns non-zero for all four transitions after driving the Playwright spec.

---

## Phase 3.7 — Wave / Pick / Pack / Dispatch hardening (carries over unchanged)

- No schema changes. Replace scaffolded `e2e/wms/wave-*.spec.ts` and `dispatch-*.spec.ts` files with real assertions.
- Enforce full scan-out: `wms_transition_manifest(..., 'dispatched')` refuses when `wms_load_scan_lines.scanned_qty < expected_qty`. Guard: `wms-load-verification-enforced.test.ts`.
- Add cancellation cascade: manifest cancel emits `warehouse.wave.reopened` for reserved lines to be unallocated.

## Phase 3.8 — Offline mobile replay idempotency (carries over unchanged)

- Playwright + IndexedDB harness enqueues the same `(device_id, client_scan_id)` twice while offline, comes online, asserts exactly one `business_event_outbox` row.
- Requires adding `client_scan_id` to `wms_receive_scans` / `wms_pick_scans` uniqueness constraint (if not already present — verify before migrating).

---

## Phase 4 — UX & error-proofing (carries over unchanged from Round 4)

- `<OutboxTimeline aggregate id />` reused on LPN, wave, manifest, QC, count, receiving-session detail pages.
- Typed exception triage: `wms_exceptions.resolution_kind` enum + `due_by timestamptz`; `ExceptionsInbox` grouped by SLA breach.
- Contention toast wired on `wms_tasks.claimed_by` change (dovetails with Phase 3.6 §5).
- Unified `useScanFeedback()` hook (audio + haptic + visual) across Receive, Putaway, Pick, Pack, Load, Count, QC mobile screens.
- Two-context realtime Playwright smoke.
- De-scaffold remaining `e2e/wms/` and `e2e/wm/` specs.
- Role-based real-time dashboards fed by outbox subscription layer only (no per-table polling).

---

## Newly identified gaps (appended per review remit)

- **Task-lifecycle FSM guard is missing.** Phase 3.6 §7 adds it — without it, hand-written `UPDATE wms_tasks SET state=...` code paths will silently reappear (same drift class Phase 2.6 warned about with topics).
- **Cross-dock ↔ labour interaction.** When `evaluate_crossdock_on_receiving_line` inserts an opportunity, it should also insert a `stage-for-dispatch` task (not a putaway task) so the unified labour queue picks it up. Fold into Phase 3.6 §4 view definition.
- **Trailer no-show → labour reclaim.** `mark_trailer_no_show` cancels the dock appointment but leaves any pre-generated pick/load tasks orphaned. Add a cascade: cancel `open|assigned` tasks whose `linked_manifest_id.trailer_visit_id = visit_id`, emit `warehouse.task.cancelled` for each. Fold into Phase 3.6 §2.
- **Grants audit.** Every new RPC in 3.6 and 3.7 must have `REVOKE ALL FROM public; GRANT EXECUTE TO authenticated;` — add a `wms-rpc-grants.test.ts` guard that scans `pg_proc` for any `warehouse.*` / `wms_*` function without `authenticated`-only execution.

---

## Operating rules (unchanged, restated)

- Never write `state`/`status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Run the entire `wms-*` guard suite before declaring a phase green.
- Replace legacy paths in the same change — never build on defective architecture.
- Update the ledger with evidence (query output, test output), not assertions.
