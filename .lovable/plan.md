# Warehouse plan — verification + resume

## Phase 0 · Verification of previous engineer's Round 5 claims

Ran the ledger claims against the codebase before drafting new work.

| Claim | Verification | Result |
|---|---|---|
| Guard suite 27 files / 103 tests green | `bunx vitest run src/test/architecture/wms-` | ✅ 27/103 green |
| `_wms_emit_task_event` is single producer for `warehouse.task.*` | grepped migrations for in-body emitters in `assign_wms_task`, `claim_pick_task`, `complete_pick_task`, `complete_pack_task`, `complete_putaway_task` | ✅ stripped in `20260729092007` |
| `TASK_PAUSED` / `TASK_RESUMED` topics + FSM edges + version-scoped idempotency key | `src/features/warehouse/events/topics.ts` + guard `wms-phase-labour-lifecycle` (6/6) | ✅ present |
| `wms_labour_queue_view` includes paused/resumed rows, cross-dock seeds pack task | guard pins `security_invoker=true` + evaluator seed | ✅ present |
| `LabourBoard` live queue panel + mobile `/warehouse/mobile/next` | files present, type-check clean | ✅ present |
| `e2e/wms/labour-claim.spec.ts` race spec | 152 LOC, real assertions on distinct winners + single outbox row per winner | ✅ real, not scaffold |
| Phase 3.7 items (scan-out enforcement, cancellation cascade, replaced e2e specs) | `wms-load-verification-enforced.test.ts` does not exist; `dispatch_loading_manifest` migrations do not enforce scanned≥expected; `wave.spec.ts` / `pick-pack-dispatch.spec.ts` are already substantive (200–333 LOC) so the "replace scaffolds" framing is stale | ⏭ Phase 3.7 genuinely pending; adjust framing (specs exist, enforcement + cancel cascade missing) |
| Phase 3.8 (offline replay idempotency) | no client_scan_id uniqueness constraint verified yet | ⏭ pending |
| Phase 4 UX (`OutboxTimeline`, typed exception triage, `useScanFeedback`, unified realtime dashboards) | none of the components exist | ⏭ pending |

**Genuine resume point = Phase 3.7.** Ledger is honest; no rework required. The only correction to the ledger is that `e2e/wms/wave.spec.ts` and `pick-pack-dispatch.spec.ts` are already real integration specs — the remaining Phase 3.7 work is enforcement + cascade + a load-verification guard, not spec authoring.

---

## Phase 3.7 · Wave / Pick / Pack / Dispatch hardening (resume here)

**Problem.** `dispatch_loading_manifest` transitions a manifest to `dispatched` without checking that every expected line has been physically scanned onto the truck. Cancelling a manifest also leaves reserved wave lines allocated — nothing emits `warehouse.wave.reopened`, so inventory stays locked and orphan `load` / `pick` tasks linger.

**Objectives.**
1. Refuse dispatch until scanned_qty ≥ expected_qty for every manifest line.
2. Cascade manifest cancellation into wave unallocation + task cancellation, all through outbox triggers (no in-body emits).
3. Prove both invariants with a guard test and extend the existing pick-pack-dispatch e2e spec.

**Steps.**

1. **Migration — enforce full scan-out.**
   - Extend `dispatch_loading_manifest` (or introduce `wms_transition_manifest`) to raise `WMS_SCAN_SHORTAGE` when any `wms_load_scan_lines.scanned_qty < expected_qty` for the manifest. Include the offending `manifest_line_id`s in the error detail so the UI can highlight them.
   - Backfill safety: for any manifest already in `dispatched` with a shortage, log to `wms_exceptions` under a new `resolution_kind = 'legacy_short_dispatch'` for audit; do not retro-block.
   - Add `REVOKE ALL … / GRANT EXECUTE TO authenticated`.

2. **Migration — manifest cancellation cascade.**
   - In `wms_transition_manifest(..., 'cancelled')` (or the equivalent RPC): unreserve wave lines linked to the manifest's cartons, set matching `wms_tasks` (`load`, open `pack` waiting on this manifest) to `cancelled` via `wms_transition_task` so the task-lifecycle trigger fires, and open a `warehouse.wave.reopened` outbox event per touched wave.
   - Add `WMS_TOPIC.WAVE_REOPENED = 'warehouse.wave.reopened'` to `topics.ts` and seed `wms_events_catalog` (producer `wms_transition_manifest`, consumer `wave_planner`, `labour`).

3. **Guard — `src/test/architecture/wms-load-verification-enforced.test.ts`.**
   - Parses `dispatch_loading_manifest` / `wms_transition_manifest` source and asserts a `scanned_qty < expected_qty` guard exists.
   - Asserts `WMS_TOPIC.WAVE_REOPENED` is present in `topics.ts` and registered in `wms_events_catalog`.
   - Extends `wms-outbox-parity.test.ts` `TRIGGER_OWNED_RPCS` with `wms_transition_manifest`.

4. **Typed hooks + UI feedback.**
   - `useDispatchManifest()` surfaces the `WMS_SCAN_SHORTAGE` error via `useToast` with a "Show short lines" action that scrolls the manifest detail to the offending rows.
   - `LoadingManifestDetail` renders a scan-progress bar per line and disables the Dispatch button until 100 %.

5. **E2E — extend `e2e/wms/pick-pack-dispatch.spec.ts`.**
   - Negative branch: call `dispatch_loading_manifest` after loading only N-1 cartons → expect the RPC error, expect manifest still in `closed`, expect exactly zero `warehouse.manifest.dispatched` outbox rows.
   - Cancel branch: cancel a `closed` manifest → assert wave rolls back to `released`, all pick tasks stay `cancelled`, one `warehouse.wave.reopened` row per wave.

**Exit criteria.** Guard suite 28+ files green, `wms-load-verification-enforced` passing, `pick-pack-dispatch.spec.ts` negative + cancel branches green.

---

## Phase 3.8 · Offline mobile replay idempotency

- Verify current `wms_receive_scans` and `wms_pick_scans` schemas for a `client_scan_id` column. If absent, add via migration with a unique index on `(device_id, client_scan_id)` scoped by scan kind; if present, confirm the uniqueness and skip the migration.
- Add `useOfflineScanQueue()` (IndexedDB) that stamps `client_scan_id = crypto.randomUUID()` and dequeues via the existing RPCs.
- Playwright harness under `e2e/wms/offline-replay.spec.ts`: enqueue the same `(device_id, client_scan_id)` receive scan twice while `context.setOffline(true)`, come online, assert exactly one `wms_receive_scans` row and one `warehouse.receiving.line_captured` outbox row.
- Guard `wms-client-scan-id-unique.test.ts` pins the uniqueness index.

---

## Phase 4 · UX & error-proofing

1. **`<OutboxTimeline aggregate id />`** — reads `business_event_outbox` filtered by `aggregate_id`, renders ordered event chips (topic, actor, elapsed). Mounted on LPN, wave, manifest, QC, count, and receiving-session detail pages. One component, six call sites.
2. **Typed exception triage.**
   - Migration: `wms_exceptions.resolution_kind` enum (`short_scan`, `damaged`, `wrong_bin`, `wrong_lp`, `legacy_short_dispatch`, `other`) and `due_by timestamptz`.
   - `ExceptionsInbox` grouped by SLA breach (`due_by < now()`), filter by kind, `resolve_exception` RPC transitions with mandatory `resolution_kind`.
3. **Contention toast.** `useWmsRealtimeSync` fires a toast when a `wms_tasks` row I am claiming flips to another user's `claimed_by`.
4. **`useScanFeedback()`** — one hook wrapping success/error audio (Web Audio), haptic (`navigator.vibrate`), and visual flash. Adopt across Receive, Putaway, Pick, Pack, Load, Count, QC mobile screens; delete per-screen `beep()` helpers.
5. **Two-context realtime Playwright smoke.** Driver A completes a task, Driver B sees it disappear from the labour queue within one realtime tick.
6. **Role-based dashboards.**
   - Inbound: appointments, receiving sessions, discrepancies, cross-dock opportunities.
   - Outbound: waves by state, pack station load, manifests awaiting dispatch, short-scan exceptions.
   - Supervisor: labour queue with SLA breach + unassigned + assigned productivity.
   - All fed by `business_event_outbox` subscription only, no per-table polling.
7. **De-scaffold audit.** Grep `e2e/wm/` and `e2e/wms/` for `test.skip` / `TODO` / empty bodies; either implement or delete.

---

## Newly identified gaps carried forward (unchanged from Round 5 review)

- Task-lifecycle FSM guard — landed in Round 5; keep enforced.
- Cross-dock ↔ labour interaction — landed in Round 5; keep enforced.
- Trailer no-show → labour reclaim — deferred; requires adding `wms_loading_manifests.trailer_visit_id` (or joining through `wms_dock_appointments`). **Include in Phase 3.7 §2 cancellation cascade** so a no-show cancels open load/pick tasks the same way a manual manifest cancel does.
- RPC grants audit — add `wms-rpc-grants.test.ts` in Phase 3.7 §3 that scans `pg_proc` for any `wms_*` function without `authenticated`-only execution.

---

## Operating rules (unchanged)

- Never write `state` / `status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Run the entire `wms-*` guard suite before declaring a phase green.
- Replace legacy paths in the same change — never build on defective architecture.
- Update `.lovable/plan.md` with evidence (query output, test output), not assertions.
