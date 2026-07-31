
# WMS — Phase 5/6 verification and completion plan

## What I verified in the codebase (pre-plan reads)

- Phase 4 artifacts all exist on disk: `src/features/warehouse/events/OutboxTimeline.tsx` + `ActivitySection.tsx`, `dashboards/DashboardPrimitives.tsx`, `scanning/useScanFeedback.tsx`, dashboards `InboundDashboard/OutboundDashboard/SupervisorDashboard` under `src/pages/warehouse/`, and the three dashboard nav entries in `src/apps/warehouse/nav.ts`.
- 31 `wms-*` architecture guard tests exist under `src/test/architecture/`, and `e2e/wms/` contains 10 specs including `realtime-contention.spec.ts` and `offline-replay.spec.ts` (no scaffold-only dirs observed).
- Phase 5 item 1 is genuinely open: `wms_replay_guarded_call` is referenced only by `src/apps/warehouse-mobile/offlineQueue.ts` (plus generated types and its guard test). Desktop screens still call RPCs directly — `CountSession.record_count`, `PackStation.open_pack_carton / assign_carton_to_pack / assign_line_to_carton / complete_pack_task`, `LoadingBay.close_loading_manifest`.
- Phase 5 item 2 is genuinely open: no `trailer_visit_id` exists anywhere in `src/` or `supabase/`.
- Phase 5 item 3 is genuinely open: no `wms-no-orphan-modules.test.ts` exists.
- Phase 5 item 5 is partly stale: `create_goods_receipt` already exists in two migrations and is referenced by `e2e/wms/receive.spec.ts`; the remaining question is whether the spec drives receipt end-to-end or still stops at the seam.

Everything below that asserts runtime behaviour (tests green, billing topics emitted) is explicitly listed as a verification step, not a claim.

## Step 0 — Re-verify the "complete" ledger by execution

1. Run `bunx vitest run src/test/architecture/wms-` and `bunx tsgo --noEmit -p tsconfig.app.json`. Any failure demotes the corresponding phase row to pending and is fixed before new work.
2. Grep-audit the six claimed `<ActivitySection />` / `<ActivityHistoryButton />` call sites and the three dashboard routes; a component with no real call site counts as pending.
3. Inspect `e2e/wms/receive.spec.ts` to determine whether TODO 14a.2 is closed. Record the answer in the plan file.

## Phase 5 — the open gaps

### 5.1 Desktop replay safety — DONE
Every quantity- or state-mutating desktop RPC is now idempotent under double-click, retry and reconnect, exactly like the mobile queue.

- Shared client seam `src/features/warehouse/scanning/replayGuardedCall.ts` stamps `client_scan_id` (intent identity, 30 s TTL over the canonicalised args) + `device_id` and dispatches through `wms_replay_guarded_call`.
- Routed through it: `useDomainOperations` (waves, pick, seal, load, dispatch, QC accept/reject/cancel, post count), `CountSession.record_count`, `PackStation` (open/assign carton, assign line, complete pack), `LoadingBay.close_loading_manifest`, `PutawayQueue` + `OperatorTasks` (`complete_putaway_task`), `ReceiveToWMSDialog.receive_goods_to_wms`.
- Server-side `CASE` whitelist extended by migration (`assign_line_to_carton`, `post_count_session`, `create_pick_wave`, `release_pick_wave`, …).
- `deviceId()` now has exactly one definition; `offlineQueue.ts` re-exports it from the seam.
- Guards: `wms-client-scan-id-unique.test.ts` gained a "Phase 5.1 — desktop replay safety" block (seam shape, single device identity, no mutating bare `supabase.rpc` in desktop WMS modules, whitelist parity). `wmsGuardUtils.domainCallRe()` now treats `replayGuardedCall(...)` as a sanctioned call site, so all 133 WMS architecture guards pass.


### 5.2 Trailer no-show → labour reclaim — DONE
- `wms_loading_manifests.trailer_visit_id` added and `open_loading_manifest` now resolves the visit (appointment link first, trailer at the dock as fallback), so every new manifest is keyed to a trailer.
- `mark_trailer_no_show` cancels the visit's `draft`/`loading` manifests through `wms_transition_manifest` — the same cascade as a manual cancel, so cartons unlink, waves reopen, and each `load` task emits `warehouse.task.cancelled` once. Emits `warehouse.labour.reclaimed` with `cancelled_manifests` / `released_load_tasks`.
- UI: Yard Board gained a "No-show" action (hidden once a trailer is at a dock) with a reason prompt — the RPC was previously unreachable from the app.
- Guard: `src/test/architecture/wms-noshow-labour-reclaim.test.ts` (6 assertions) pins the cascade shape, the reclaim payload, and topic registration. 32 WMS guard files / 139 tests green; typecheck clean.
- Remaining: Playwright `yard-no-show.spec.ts` still to be written (tracked under Phase 6 E2E).

### 5.3 Orphan-module guard — DONE
- `src/test/architecture/wms-no-orphan-modules.test.ts`: builds the real import graph over `src/**` (static, re-export and dynamic imports; `@/` + relative resolution) and fails when any file under `src/features/warehouse/**` has no importer outside `src/test/**`. No allow-list by design.
- Orphan found and fixed rather than deleted: `aggregates/useAggregateTransitions.ts` (typed `wms_transition_*` FSM hooks, ADR 0101) had zero production call sites — no screen could cancel a wave, manifest or count session even though the server supported it.
- New shared UI seam `src/features/warehouse/aggregates/CancelAggregateButton.tsx`: mandatory reason, per-aggregate consequence copy, hides itself when the FSM has no `cancelled` edge from the current state, passes `row_version` so concurrent supervisors get a typed conflict instead of a lost update.
- Mounted on `WavePlanner.tsx`, `LoadingManifests.tsx` and `CountReview.tsx`; those queries now select `row_version` and invalidate on success.
- Evidence: 33 WMS guard files / 142 tests green; orphan scan returns empty; typecheck clean.

### CURRENTLY ACTIVE → 5.4 3PL billing event coverage


### 5.4 3PL billing event coverage
- Enumerate the billable activities (receipt lines, storage days, picks, packs, shipments) and confirm each emits a topic that `BillingBoard` consumes; where a topic is missing, add the trigger emission and a topic-catalog entry.
- Guard: extend `wms-topic-catalog-sync.test.ts` with a billable-topic completeness assertion.

### 5.5 Receiving E2E closure
- Depending on Step 0.3, either close the `create_goods_receipt` seam in `e2e/wms/receive.spec.ts` so receipt is driven from the UI, or mark item 5 resolved with evidence.

## Phase 6 — newly identified gaps (appended by this review)

1. **Cross-dock end-to-end proof.** `wms-crossdock-subscriber.test.ts` exists but there is no `e2e/wms/crossdock.spec.ts`; inbound→outbound bypass is the highest-risk untested flow.
2. **Returns lifecycle depth.** `ReturnOrders.tsx` exists; verify RMA → receive → QC → disposition (return-to-stock / scrap) each transition through `wms_transition_*` and emit outbox topics, with an owner-side read path for held stock.
3. **Label printing queue.** Confirm `features/warehouse/labels` is a real central print queue (LP / bin / shipping) with retry + failure surfacing, not a direct-print helper; add a queue view if missing.
4. **Concurrency semantics on shared aggregates.** Add optimistic-concurrency (version or `updated_at` check) to bin/LP mutations so two operators on the same LP get a typed conflict, not a lost update; surface it with the existing contention toast.
5. **Exception SLA escalation.** `due_by` exists; add the scheduled escalation path (breach → supervisor queue) rather than passive grouping.
6. **Inventory reconciliation guard.** A test that WMS-side quantity movements always land as canonical Inventory ledger effects (no WMS-only stock drift), per ADR 0079.

## Execution rules (carried forward)

- Never write `state` / `status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Replace legacy paths in the same change; delete dead modules instead of layering.
- A phase is green only when the full `wms-*` guard suite plus typecheck pass, and the plan file records the actual output as evidence.

## Order of work

Step 0 → 5.1 ✅ → 5.2 ✅ → 5.3 ✅ → **5.4 (next)** → 5.5 → Phase 6 in listed order, updating `.lovable/plan.md` with evidence after each item.

## Instructions for the next agent

1. **Verify 5.3 before extending anything.** Run `bunx vitest run $(ls src/test/architecture/wms-*.test.ts)` (expect 33 files / 142 tests) and `bunx tsgo --noEmit -p tsconfig.json`. Then open Wave Planner, Loading Manifests and Count Review in the preview and confirm Cancel appears only in cancellable states, requires a reason, and that a stale `row_version` surfaces a conflict rather than silently winning.
2. **Then resume at 5.4**, not elsewhere: enumerate billable activities, confirm each emits a topic `BillingBoard` consumes, add missing trigger emissions plus catalog rows, and extend `wms-topic-catalog-sync.test.ts` with a billable-topic completeness assertion.
3. Keep the execution rules above: no direct `state` writes, no in-body event emission, no partially wired features, and record real command output as evidence in this file after each item.

