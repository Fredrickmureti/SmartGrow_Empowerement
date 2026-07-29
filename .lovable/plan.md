
# WMS Continuation Plan — Verified Handoff

## Phase 0 — Verification results (evidence-based)

I re-audited the previous engineer's Phase 1 claims against the live codebase and database. Results:

**Confirmed shipped (green — no rework needed):**
- ADR `docs/adr/0101-wms-domain-and-event-catalog.md` present.
- SQL RPCs present in DB: `_wms_emit_outbox`, `wms_transition_task`, `wms_transition_lpn`, `wms_transition_receiving`, `wms_transition_return`, `wms_raise_exception`, `wms_resolve_exception`, `wms_claim_next_task`, `wms_task_heartbeat`, `wms_task_reap_expired`.
- Tables present: `wms_events_catalog`, `wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `wms_replen_rules`, `wms_slotting_rules`, `wms_tasks`, `wms_license_plates`.
- TS: `src/features/warehouse/events/topics.ts` (full topic catalog) and `src/features/warehouse/tasks/useTaskEngine.ts`.
- Pages: `OperatorTasks`, `LicensePlateView`, `ExceptionsInbox`, `ReceivingSessions`, `ReturnOrders` — all present and wired in nav/routes; migrated off direct `.update({ state })`.

**Confirmed pending (accurately flagged by prior engineer — carried forward):**
- `PutawayQueue.tsx:115` still calls `.update({ state: "in_progress", … })` on `wms_tasks`. Regression risk: bypasses FSM guard, no outbox emit. Must be fixed as part of Phase 2.4 (concurrency sweep) — earlier if any operator uses that surface.
- `WavePlanner`, `PickList`, `PackStation`, `LoadingBay`, `QCQueue`, `CountSession` — no `wms_transition_*` RPCs yet, still direct writes.
- `docs/architecture/WMS_MODULE_OWNERSHIP.md` — not written.

**New findings not captured by prior engineer (added to backlog):**
- N1. No architecture guard test forbidding `.update({ state })` / `.update({ status })` on WMS aggregates outside `wms_transition_*` RPCs. Without it, regressions like `PutawayQueue` will silently return.
- N2. No idempotency-key uniqueness verified on `business_event_outbox` for `wms.*` keys — need a query + (if missing) a partial unique index so double-clicks and offline replay dedupe at the DB.
- N3. `wms_task_reap_expired` exists but no scheduler (pg_cron / edge cron / TSS route) invokes it. Stuck leases will accumulate.
- N4. Receiving/Return/Exception pages need at least one Playwright smoke that walks a transition and asserts the outbox row lands with the correct topic + idempotency key — currently unverified end-to-end.
- N5. `wms_events_catalog` is seeded but no CI check ensures the TS `WMS_TOPIC` constants and the SQL catalog stay in sync.
- N6. Realtime publication membership for the new WMS tables is unconfirmed; Phase 2.3 requires them on `supabase_realtime`.

Conclusion: **resume at Phase 2 Step 1** as the ledger states, but pull `PutawayQueue` fix + N1 guard + N2 idempotency index forward as prerequisites so we don't build the scan/label/realtime layer on shaky ground.

---

## Phase 2 — Hardware & real-time integration (ACTIVE)

### 2.0 — Prerequisite hardening (do first, this turn)
1. **Fix `PutawayQueue`** — replace the direct `.update` with `wms_transition_task` (`to_state='in_progress'`) via `useTaskEngine`. Verify outbox emits `warehouse.task.in_progress`.
2. **Architecture guard test** `src/test/architecture/wms-no-direct-state-writes.test.ts` — greps `src/pages/warehouse/**` and `src/apps/warehouse/**` for `.update(` calls whose object literal contains `state:` / `status:` targeting known WMS tables; fails CI if any exist outside a `_wms_transition_*` allowlist.
3. **Outbox idempotency** — migration adds `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS business_event_outbox_idem_uniq ON business_event_outbox(idempotency_key) WHERE idempotency_key LIKE 'wms.%';` (only if not already unique). `_wms_emit_outbox` upgraded to `ON CONFLICT DO NOTHING`.
4. **Topic/catalog sync test** — `wms-topic-catalog-sync.test.ts` selects `topic` from `wms_events_catalog` and asserts set equality with `Object.values(WMS_TOPIC)`.

### 2.1 — Scan Intent registry
- Extend `src/services/scanner/scanRouter.ts` with a typed `ScanIntent` union: `receiving.lpn | receiving.item | putaway.bin | putaway.lpn | pick.location | pick.item | pack.carton | load.lpn | count.location | count.item | qc.lpn`.
- Every WMS page declares its active intent on mount (`useScanIntent(intent)`); unexpected scans route to `scanFeedbackBus.error('unexpected_intent', …)` with audio+haptic.
- GS1 pre-parse (ADR 0071) stays in front; intent handler receives normalized `{ gtin, lot, serial, expiry, quantity, raw }`.
- One consumer wired end-to-end this sub-phase: `ReceivingSessions` accepts `receiving.lpn` and `receiving.item` scans and calls `wms_transition_receiving` transitions accordingly.

### 2.2 — Standard label templates
Author four `document_templates` + `document_template_ast` rows via a migration seed (per ADR 0084/0085 pipeline — no hand rendering):
- `wms.label.lpn` (SSCC-style GS1-128 + human LP id + warehouse + created_at)
- `wms.label.bin` (Code 128 of `stock_locations.barcode` + human aisle-rack-shelf-bin + zone)
- `wms.label.shipping` (carrier-agnostic base; carrier overlays deferred)
- `wms.label.packing_slip` (order header + lines + LPN summary)

Wire each into the print pipeline (`src/services/printing/dispatch.ts`) with a preview action from `LicensePlateView`, layout editor bin row, and pack-station carton respectively.

### 2.3 — Realtime board fabric
- Confirm/`ALTER PUBLICATION supabase_realtime ADD TABLE` for: `wms_tasks`, `wms_license_plates`, `wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `receiving_appointments`, `pick_waves`, `shipment_packages`, `loading_manifests`, `qc_inspections`, `wms_count_sessions`.
- Add `src/features/warehouse/realtime/useWmsRealtimeSync.ts`, mirroring `useInventoryRealtime`; subscribed inside `useEffect` with `removeChannel` cleanup; scoped by `business_id`; invalidates matching React Query keys with `refetchType: 'active'`.
- Convert `OperatorTasks`, `ReceivingSessions`, `ReturnOrders`, `ExceptionsInbox`, `LicensePlates` from poll to subscribe.

### 2.4 — Concurrency sweep
Add `wms_transition_{wave,pack,manifest,qc,count_session}` RPCs (same shape as `wms_transition_receiving`: SECURITY DEFINER, row_version optimistic lock, FSM guard table, `_wms_emit_outbox`). Migrate `WavePlanner`, `PackStation`, `LoadingBay`, `QCQueue`, `CountSession` off direct updates. Re-run the guard from 2.0 §2 to prove zero direct writes remain.

### 2.5 — Lease reaper + offline queue
- Schedule `wms_task_reap_expired()` via pg_cron every minute; emits `warehouse.task.available` on release.
- Mobile IndexedDB scan queue keyed by `(device_id, client_scan_id)`; replay through the same transition RPCs; idempotency guaranteed by the outbox unique index from 2.0 §3.

### 2.6 — Documentation
Write `docs/architecture/WMS_MODULE_OWNERSHIP.md` (deferred from Phase 1.6): producer/consumer matrix per topic; who owns writes to each aggregate; how Inventory consumes `warehouse.*` events without back-writing.

---

## Phase 3 — Per-module deep improvements
Unchanged from prior plan (Operator tasks, Putaway, Wave planner, Replenishment, Cycle counts, Dispatch, Dock/Yard, QC, Slotting, Labour, 3PL Billing, Cross-dock, Master). Each module lands: DB migration → transition RPC (if not in Phase 2.4) → typed TS wrapper → page consumption → Playwright smoke → guard test.

Additions surfaced by audit:
- **Cross-dock trigger**: on `warehouse.receiving.line_captured`, evaluate open outbound reservations; emit `warehouse.crossdock.matched` and short-circuit putaway. Requires a `wms_reservations` view over `stock_quants` reservation columns.
- **QC hold contract**: quarantine transitions LPN to `quarantined` AND writes an `inventory.status_hold` row so Inventory allocators skip it. Currently Inventory has no hold surface — coordinate with ADR 0079 owner before shipping.

---

## Phase 4 — UX & error-proofing
Unchanged. Adds:
- **Exception triage screen** (`/warehouse-app/exceptions/:id`) — typed resolution actions call `wms_resolve_exception` with a required `resolution_kind` enum, not free text.
- **Aggregate audit timelines** — reusable `<OutboxTimeline aggregate="lpn" id={…} />` component reads `business_event_outbox` filtered by `idempotency_key LIKE 'wms.<aggregate>:<id>:%'`.

---

## Operating rules (unchanged, restated)
- Never write `state`/`status` directly to a WMS aggregate — always via `wms_transition_*` RPC.
- Every sub-phase ships: migration + typed wrapper + at least one consuming page + a working transition in preview + guard/test coverage.
- Update the Execution Ledger in `.lovable/plan.md` after each sub-phase.

## Execution ledger (post-verification)
- **Active:** Phase 2, at 2.3 (Realtime board fabric) next. 2.0 hardening, 2.1 Scan Intents (Receiving consumer), and 2.2 Label templates all landed.
- **Green:** All Phase 1. Phase 2.0 §1–§4 (PutawayQueue via useTaskEngine, `wms-no-direct-state-writes` guard, outbox idempotency, catalog sync guard). Phase 2.1 `useWmsScanIntent` + Receiving consumer with GS1 pre-parse. Phase 2.2 canonical labels: SQL seeder `wms_seed_default_label_templates(_org_id, _actor)` upserts `wms.label.lpn` / `wms.label.bin` / `wms.label.shipping` into `label_templates.body_json` (LabelDoc), packing slip upgraded on `document_template_ast` (kind=`inventory.packing_slip`, system scope, adds `lpn_summary` block); migration back-fills every existing org. TS wrapper `src/features/warehouse/labels/wmsLabels.ts` exposes typed `WMS_LABEL_KEY` + `printWmsLabel`. `LicensePlateView` header has a Print-label action. Guard test `wms-label-keys-sync.test.ts` pins TS keys ↔ SQL seeder.
- **Pending (was flagged):** module ownership doc (2.6), Wave/Pack/Manifest/QC/CountSession RPCs (2.4).
- **Pending (new, from audit):** task reaper schedule (N3, 2.5), transition Playwright smoke (N4), realtime consumers wired to boards (2.3 — publication + REPLICA IDENTITY already landed; consumer hook + page rewires remaining).

## Handoff — next agent
1. **Verify Phase 2.2 first.** Confirm: (a) `SELECT template_key FROM label_templates WHERE template_key LIKE 'wms.label.%'` returns the three thermal keys for every org; (b) `document_template_ast` system row for `inventory.packing_slip` contains an `lpn_summary` block; (c) `bunx vitest run src/test/architecture/wms-label-keys-sync.test.ts` passes; (d) build is green.
2. **Then resume at Phase 2.3 — Realtime board fabric.** Publication + `REPLICA IDENTITY FULL` for `wms_tasks` / `wms_license_plates` / `wms_events_catalog` already landed. Remaining work: add the missing tables to `supabase_realtime` (`wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `receiving_appointments`, `pick_waves`, `shipment_packages`, `loading_manifests`, `qc_inspections`, `wms_count_sessions`), author `src/features/warehouse/realtime/useWmsRealtimeSync.ts` (subscribe inside `useEffect`, `removeChannel` cleanup, scope by `business_id`, invalidate matching React Query keys with `refetchType: 'active'`), and convert `OperatorTasks`, `ReceivingSessions`, `ReturnOrders`, `ExceptionsInbox`, `LicensePlates` from poll to subscribe.
3. **Do not skip ahead.** 2.3 must be production-ready (types, guards, at least one Playwright smoke that observes a realtime-driven UI update) before touching 2.4 concurrency RPCs or 2.5 reaper scheduling.
