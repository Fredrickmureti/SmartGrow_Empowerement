
# WMS Continuation Plan — Verified Handoff (Round 2)

## Phase 0 — Verification of prior engineer's claims

Audited `.lovable/plan.md` ledger against the live codebase.

**Confirmed accurate (green):**
- Phase 1 substrate: `wms_transition_*` RPCs, `wms_events_catalog`, exceptions/receiving/return tables, TS `WMS_TOPIC` catalog — all present.
- Phase 2.0 §1 — `PutawayQueue` no longer uses direct `.update({ state })`. Grep across `src/pages/warehouse/**` finds **zero** `.update({ state: … })` or `.update({ status: … })` calls. Guard test `wms-no-direct-state-writes.test.ts` is present.
- Phase 2.0 §4 — `wms-topic-catalog-sync.test.ts` present.
- Phase 2.1 — scan intent hook + Receiving consumer wired.
- Phase 2.2 — `wmsLabels.ts` wrapper, `wms_seed_default_label_templates` seeder, `wms-label-keys-sync.test.ts` guard, LicensePlateView print action all present.

**Confirmed pending (accurately flagged, carried forward):**
- `src/features/warehouse/realtime/` does not exist → Phase 2.3 truly unstarted.
- `WavePlanner`, `PickList`, `PackStation`, `LoadingBay`, `QCQueue`, `CountSession` still call domain RPCs (`create_pick_wave`, `seal_pack_carton`, `complete_pick_task`, …) — not FSM-guarded via `wms_transition_*`, no unified outbox emit. Phase 2.4 legitimately pending.
- `docs/architecture/WMS_MODULE_OWNERSHIP.md` — absent. 2.6 pending.
- No pg_cron / scheduled reaper for `wms_task_reap_expired`. 2.5 pending.

**Newly surfaced (append to backlog):**
- N7. Domain RPCs used by Wave/Pack/Load/Pick pages (`create_pick_wave`, `seal_pack_carton`, `dispatch_loading_manifest`, `complete_pick_task`, `load_carton_onto_manifest`) predate the `_wms_emit_outbox` helper. Need audit: do they emit onto `business_event_outbox` with `wms.*` idempotency keys? If not, Realtime boards will miss updates until 2.4 lands. Verify **before** 2.3 UI rewire so realtime consumers are wired to tables that actually broadcast.
- N8. `RECEIVING_LINE_CAPTURED` event is declared in `topics.ts` but no cross-dock consumer exists — Phase 3 cross-dock trigger is currently a topic without a subscriber.
- N9. `wms_exceptions` has no severity/SLA fields visible in the exception inbox; Phase 4 triage screen needs typed `resolution_kind` enum promoted to schema.
- N10. Multi-user contention: `wms_claim_next_task` uses `FOR UPDATE SKIP LOCKED`, but no page yet displays "claimed by other operator" state; UX needs an explicit "someone else took this" toast when realtime lands.

Resume point: **Phase 2.3 — Realtime board fabric**, prefaced by an N7 audit.

---

## Phase 2 — Hardware & real-time (ACTIVE)

### 2.3 — Realtime board fabric
1. **Outbox audit (N7).** For each domain RPC used by Wave/Pack/Load/Pick/QC/Count pages, confirm it INSERTs into `business_event_outbox`. Where missing, add the emit in the same migration that ships the transition RPC in 2.4 — do **not** patch legacy RPCs piecemeal.
2. **Publication membership.** Migration: `ALTER PUBLICATION supabase_realtime ADD TABLE` for the missing set (`wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `receiving_appointments`, `pick_waves`, `shipment_packages`, `loading_manifests`, `qc_inspections`, `wms_count_sessions`); `ALTER TABLE … REPLICA IDENTITY FULL` on each.
3. **Consumer hook.** `src/features/warehouse/realtime/useWmsRealtimeSync.ts` — one channel per business_id, subscribes inside `useEffect`, `removeChannel` on cleanup, invalidates React Query keys with `refetchType: 'active'`. Mirror shape of `useUnifiedRealtimeSync`.
4. **Page rewires.** `OperatorTasks`, `ReceivingSessions`, `ReturnOrders`, `ExceptionsInbox`, `LicensePlates` switch from polling to subscription.
5. **Playwright smoke (N4).** Open two browser contexts; context A transitions a task; context B asserts the row updates within 2s without navigation.

### 2.4 — Concurrency sweep (FSM + outbox parity)
Author `wms_transition_wave`, `wms_transition_pack_carton`, `wms_transition_manifest`, `wms_transition_qc`, `wms_transition_count_session`. Same shape as `wms_transition_receiving` (SECURITY DEFINER, `row_version` optimistic lock, FSM guard table, `_wms_emit_outbox` with `wms.<aggregate>:<id>:<transition>` idempotency key). Migrate Wave/Pack/Load/QC/Count pages onto typed TS wrappers (`useTaskEngine`-style). Legacy RPCs stay as internal helpers called by the new transition functions — no page imports them directly. Re-run guard test.

### 2.5 — Lease reaper + offline scan queue
- pg_cron every 60s: `SELECT wms_task_reap_expired(w.id) FROM warehouses w WHERE w.is_active`. Emits `warehouse.task.available` on release.
- Mobile IndexedDB queue keyed by `(device_id, client_scan_id)`; replay through the same transition RPCs. Idempotency handled by the `wms.*` unique index landed in 2.0 §3.
- N10 UX: when a subscribed row flips to `claimed` by a different `assignee_user_id`, show a non-blocking toast "Task taken by <name>" and remove from the local list.

### 2.6 — Ownership doc
`docs/architecture/WMS_MODULE_OWNERSHIP.md`: producer/consumer matrix per topic; who owns writes to each aggregate; how Inventory consumes `warehouse.*` events without back-writing. Cross-link ADR 0079 and 0101.

---

## Phase 3 — Per-module deep improvements

Order chosen by business impact + dependency:

1. **Receiving** (already partly wired) — finish ASN→GRN→putaway task fan-out; wire `warehouse.receiving.line_captured` → cross-dock evaluator (N8).
2. **Putaway** — slotting rule read on task generation (`wms_slotting_rules`); scan-guarded destination bin; audit `stock_movements` source/destination stamping (ADR 0079 §4).
3. **Wave planner / Pick / Pack** — wave rules table, reservation model over `stock_quants`, FSM transitions from 2.4, packing station carton lifecycle events already in topic catalog.
4. **Dispatch / Loading manifests** — load-verify scan flow; carrier-agnostic shipping label (2.2 template already exists); manifest close/dispatch via `wms_transition_manifest`.
5. **Dock schedule + Yard** — appointment → receiving_session linkage; trailer status FSM.
6. **QC** — typed resolution enum (N9); quarantine writes `inventory.status_hold` (coordinate with ADR 0079 owner before shipping).
7. **Cycle counts** — schedule engine, discrepancy → `stock_adjustments` with approval workflow reuse.
8. **Replenishment** — `wms_replen_rules` engine; threshold trigger on `stock_quants` change events; task fan-out.
9. **Slotting** — rules engine surface + re-slot task generator.
10. **Labour** — task time-tracking from `wms_tasks.claimed_at` / `completed_at`; productivity dashboards.
11. **3PL billing** — activity meter over `business_event_outbox` (`warehouse.receiving.closed`, `warehouse.lpn.stored` days, `warehouse.pick.completed`, `warehouse.carton.shipped`).
12. **Cross-dock** — subscriber for `warehouse.receiving.line_captured`, matches open reservations, emits `warehouse.crossdock.matched`, short-circuits putaway (N8).

Each module lands the standard vertical: migration → transition/domain RPC → typed TS wrapper → page consumption → realtime subscription → Playwright smoke → architecture guard.

---

## Phase 4 — UX & error-proofing
- Role-based operator dashboards (mobile-first task queue, supervisor exception board, 3PL billing viewer).
- `<OutboxTimeline aggregate="lpn" id={…} />` reusable audit component reading `business_event_outbox` by `idempotency_key LIKE 'wms.<aggregate>:<id>:%'`.
- Exception triage screen with enum-driven resolution (N9).
- Scan feedback: audio+haptic on `scanFeedbackBus` for every intent mismatch; unified across Receiving, Putaway, Pick, Pack, Load, Count, QC.
- Multi-operator contention toasts (N10).

---

## Operating rules (restated)
- Never write `state` / `status` directly to a WMS aggregate — always via a `wms_transition_*` RPC.
- Every RPC emits onto `business_event_outbox` with `wms.<aggregate>:<id>:<transition>` idempotency key.
- Every sub-phase ships: migration + typed wrapper + at least one consuming page + Playwright smoke + guard test.
- Update the Execution Ledger after each sub-phase.

## Execution ledger
- **Active next:** Phase 2.3 §5 — two-context Playwright smoke that proves realtime propagation of a wave/manifest/QC/count transition within 2s across browser sessions. After that, Phase 2.5 (pg_cron lease reaper + offline mobile scan queue). Then Phase 2.6 ownership doc, then Phase 3 module deep-dives beginning with Receiving cross-dock (N8) — `warehouse.receiving.line_captured` currently has no consumer.
- **Green:** All Phase 1; Phase 2.0/2.1/2.2 verified. **Phase 2.3 shipped.** **Phase 2.4 §1 shipped** — `row_version` + auto-bump trigger on the five aggregates, `warehouse.carton.loaded` emission gap closed, topic mirrored into catalog + `WMS_TOPIC.CARTON_LOADED`. **Phase 2.4 §2 shipped** — four new SECURITY DEFINER transition RPCs (`wms_transition_wave`, `wms_transition_manifest`, `wms_transition_qc`, `wms_transition_count_session`), each optimistic-locked on `row_version`, FSM-guarded, lifecycle-stamping, and outbox-emitting via `_wms_emit_outbox` with `wms.<aggregate>:<id>:<state>` idempotency keys. 24 new topics registered in `wms_events_catalog` and mirrored into `WMS_TOPIC` (`WAVE_*`, `MANIFEST_*`, `QC_*`, `COUNT_*`); `idempotencyKey()` union widened to include the new aggregate names. Typed TS wrapper landed at `src/features/warehouse/aggregates/useAggregateTransitions.ts` with mismatch-aware toast copy. **Phase 2.4 §3 shipped** — page migration onto typed domain-op wrappers. New file `src/features/warehouse/aggregates/useDomainOperations.ts` exposes `useCreateAndReleaseWave`, `useCompletePickTask`, `useSealCarton`, `useLoadCartonOntoManifest`, `useDispatchManifest`, `useAcceptQcInspection`, `useRejectQcInspection`, `useCancelQcInspection`, `usePostCountSession` — each with unified `row_version`-mismatch toast copy and consistent React Query invalidation. Refactored pages: `WavePlanner`, `PickList`, `PackStation`, `LoadingBay`, `CountReview`, `QCInspectionDetail`. New architecture guard `wms-no-direct-domain-rpc.test.ts` bans direct `supabase.rpc("<domain>", …)` calls from `src/pages/warehouse/**` for the ten sanctioned domain RPCs. All four WMS architecture guards remain green (`wms-no-direct-state-writes`, `wms-no-direct-domain-rpc`, `wms-topic-catalog-sync`, `wms-realtime-publication-sync`). Typecheck clean.
- **Pending:** 2.3 §5 two-context Playwright smoke; 2.5 pg_cron reaper + offline IndexedDB scan queue (idempotent replay through `wms.*` unique key); 2.6 ownership doc `docs/architecture/WMS_MODULE_OWNERSHIP.md`; Phase 3 module deep-dives (start with Receiving + cross-dock subscriber for N8); Phase 4 UX (exception triage with typed resolution enum for N9; multi-operator contention toasts for N10; `<OutboxTimeline>` audit component).

## Handoff notes for the next agent
1. **Verify first.** Before writing code, run:
   - `bunx vitest run src/test/architecture/wms-*.test.ts` → four guards must be green.
   - `bunx tsgo --noEmit` → clean.
   - Spot-check that `WavePlanner`, `PickList`, `PackStation`, `LoadingBay`, `CountReview`, `QCInspectionDetail` compile and their action buttons still function against a live wave/manifest/QC/count in the preview.
   - Confirm `supabase.rpc("release_pick_wave", …)` / `dispatch_loading_manifest` / `post_count_session` / `accept_qc_inspection` / `reject_qc_inspection` / `cancel_qc_inspection` / `seal_pack_carton` / `complete_pick_task` / `load_carton_onto_manifest` do **not** appear in `src/pages/warehouse/**` — the new guard enforces this.
2. **Only then continue.** Resume at **Phase 2.3 §5** — author a Playwright script under `/tmp/browser/wms-realtime/` that opens two authenticated contexts, has context A run a wave transition, and asserts context B's board reflects the state change within 2s without navigation. This closes the last outstanding item in Phase 2.3.
3. **Then** move to Phase 2.5 (pg_cron `wms_task_reap_expired` + IndexedDB offline scan replay). Do not skip to Phase 3 until the reaper is live and the offline queue's idempotency has been proven against the `wms.*` outbox unique index.
4. **Do not** refactor unrelated modules mid-phase. Ship each sub-phase as a coherent vertical (migration → typed wrapper → page consumption → realtime → Playwright smoke → guard test) before starting the next.
