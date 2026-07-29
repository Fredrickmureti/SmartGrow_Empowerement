# Warehouse plan — verification + resume

**Active phase → Phase 4 (UX & error-proofing).** Phases 3.6 / 3.7 / 3.8 are all complete and pinned by architecture guards. Next agent: first re-run `bunx vitest run src/test/architecture/wms-` and `bunx tsgo --noEmit` to confirm the 30 guard files / 113 tests + typecheck are still green, then start Phase 4 §1 (`<OutboxTimeline aggregateId />`). Do NOT skip ahead to §2 (typed exception triage) or §6 (dashboards) — §1 is the shared primitive the later steps consume.



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

## Phase 3.7 · Wave / Pick / Pack / Dispatch hardening (§1–4 complete)

**Status.** DB enforcement, cancellation cascade, guards, desktop + mobile UI feedback, and E2E negative/cancel branches all landed.

**Shipped this phase.**

1. **Migration — full scan-out enforcement.**
   - `wms_transition_manifest` refuses `closed`/`dispatched` when any sealed pack carton for a (wave, SO) pair on the manifest is still unshipped → `WMS_SCAN_SHORTAGE` with `missing_carton_ids` in `DETAIL`.
   - Same guard added to the legacy `close_loading_manifest` / `dispatch_loading_manifest` RPCs (still called by desktop LoadingBay + mobile) via shared helper `wms_manifest_short_cartons(uuid)`.
   - REVOKE ALL + GRANT EXECUTE to `authenticated,service_role` on all three.

2. **Migration — cancellation cascade.**
   - `wms_transition_manifest('cancelled')` unbinds `wms_pack_cartons.manifest_id`, cancels open `load` tasks via `wms_transition_task` (task-lifecycle trigger fires), and emits one `warehouse.wave.reopened` outbox row per touched wave with idempotency key `wms.wave:{wave_id}:reopened_by_manifest:{manifest_id}`.
   - `WMS_TOPIC.WAVE_REOPENED = "warehouse.wave.reopened"` seeded in `wms_events_catalog` and documented in `docs/architecture/WMS_MODULE_OWNERSHIP.md`.

3. **Guards.**
   - `wms-load-verification-enforced.test.ts` pins `WMS_SCAN_SHORTAGE`, the wave-reopened topic, task-lifecycle cancellation edge, and carton-unbind SQL.
   - `wms-rpc-grants.test.ts` scans every `wms_*` function and asserts `GRANT EXECUTE TO authenticated` (with a scoped `SCHEDULED_ONLY` exemption for `wms_task_reap_expired`). Closed the gap on `wms_transition_task`, `wms_transition_lpn`, `wms_claim_next_task`, `wms_task_heartbeat`.

4. **UI feedback.**
   - `useDispatchManifest` detects `WMS_SCAN_SHORTAGE`, shows a distinct "sealed cartons missing" toast, and invalidates the shortage query so the banner refreshes.
   - `LoadingBay` reads `wms_manifest_short_cartons(id)` on a 15s interval, renders a scan-out progress bar (loaded / missing, amber → emerald at 100%), and disables both Close and Dispatch until shortage is 0.
   - `MobileDispatch` (`enqueue`) catches the same RPC error and surfaces a plain-language "Scan every sealed carton for this wave/SO onto the manifest first" toast, with distinct wording for close vs dispatch. Shortage *preview* is deliberately not fetched on the RF shell — the Phase 13 mobile guard forbids direct `supabase.rpc` there, so the RPC itself is the source of truth on close/dispatch.

5. **E2E negative + cancel branches.**
   - New spec `e2e/wms/dispatch-scan-out-and-cancel.spec.ts` builds two independent packed waves per run:
     - *Scenario A* — seals 2 cartons for the same (wave, SO), loads only 1, asserts `close_loading_manifest` returns non-OK with `WMS_SCAN_SHORTAGE`, manifest stays `loading`, then loads the second carton and confirms close + dispatch recover to `dispatched`.
     - *Scenario B* — loads 1 sealed carton, calls `wms_transition_manifest(..., 'cancelled')`, and asserts (i) manifest → `cancelled`, (ii) `wms_pack_cartons.manifest_id` cleared, (iii) every prior `load` task → `cancelled`, (iv) at least one `warehouse.wave.reopened` outbox row for the wave id.

**Exit criteria.** 29 guard files / 108 tests green ✅; typecheck clean ✅; E2E spec added and typechecks ✅.




---

## Phase 3.8 · Offline mobile replay idempotency — COMPLETE

**Status.** DB ledger, wrapper RPCs, IndexedDB hook, guard, and E2E replay spec all landed. Guard suite 30 files / 113 tests green ✅; typecheck clean ✅.

**Shipped this phase.**

1. **Ledger + wrappers migration.**
   - New table `wms_client_scan_receipts` with `UNIQUE (device_id, client_scan_id)`. Readable under business-scoped RLS; writes go only through the SECURITY DEFINER wrappers.
   - Internal helpers `_wms_client_scan_lookup(device, key)` and `_wms_client_scan_record(...)`. The lookup takes a `pg_advisory_xact_lock(hashtextextended(device||':'||key))` so two concurrent replays cannot both slip past the check.
   - Public RPC `wms_capture_receiving_line(session, product, qty, …, client_scan_id, device_id)` — inserts one `wms_receiving_lines` row, records the receipt, returns `{ line_id, session_id, received_qty, replayed }`.
   - Public RPC `wms_complete_pick_scan(task_id, qty, lpn, client_scan_id, device_id)` — wraps `complete_pick_task` with the same replay guard.
   - Both RPCs: `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated, service_role`. Note: because the receiving-line trigger emits `warehouse.receiving.line_captured` with an idempotency key derived from `line_id`, dedup is doubly enforced — the ledger prevents second insert, and the outbox key would collapse it anyway.

2. **Client hook.**
   - `src/features/warehouse/scanning/useOfflineScanQueue.ts` — IndexedDB store (`wms_offline_scans`, keyPath `client_scan_id`), stamps `client_scan_id = crypto.randomUUID()`, stable per-device id in `localStorage.wms_client_device_id` (`device-<uuid>`).
   - `enqueueReceivingLine(args)` / `enqueuePickCompletion(args)` return the client_scan_id and trigger a drain when `navigator.onLine`.
   - Auto-drains on `online` events and every 5s. FIFO with stop-on-first-failure so ordering is preserved. Server ack (including `replayed: true`) clears the entry.
   - Phase 13 mobile guard respected: this hook is the ONLY module in the RF shell that touches `supabase.rpc` for these two RPCs. Screens must go through `enqueue*` rather than reaching for `supabase` directly.

3. **Guard.**
   - `src/test/architecture/wms-client-scan-id-unique.test.ts` (5 tests) pins: the table + unique index, the lookup/record helpers, the advisory-lock serialisation, GRANT/REVOKE on both wrappers, and that `useOfflineScanQueue` stamps `client_scan_id` via `crypto.randomUUID()` and forwards both replay args to both RPCs.

4. **E2E replay spec.**
   - `e2e/wms/offline-replay.spec.ts` — opens a receiving session, fires `wms_capture_receiving_line` three times with the same `(device_id, client_scan_id)`, asserts (i) first call `replayed=false`, (ii) both follow-ups `replayed=true`, (iii) all three responses point to the same `line_id`, (iv) exactly one `wms_receiving_lines` row and exactly one `warehouse.receiving.line_captured` outbox row exist for that scan.

**Exit criteria.** 30 guard files / 113 tests green ✅ (added `wms-client-scan-id-unique`); typecheck clean ✅; E2E spec authored.

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
