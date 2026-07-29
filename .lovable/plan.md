
# Enterprise WMS Architecture Review & Phased Roadmap

Scope: the Warehouse app (`src/apps/warehouse/*`, `src/pages/warehouse/*`) sitting on top of the Inventory ledger (ADR 0064/0068/0076/0078), the stock event fabric (`business_event_outbox`), and the hardware runtime (`src/services/hardware/*`, `electron/hardware/*`, ADR 0037/0099). Bounded by ADR 0079 (Inventory owns quantity/cost; Warehouse owns physical execution) and ADR 0080 (Warehouse owns the facility master).

Nothing in this plan changes Inventory writers, valuation, POS, Finance, or Localization. Everything is additive on top of `wms_*` and the existing outbox.

---

## Part A — Current-state architecture map (verified from code)

### A.1 Modules present today
Operations pages: `OperatorTasks`, `PutawayQueue`, `WavePlanner`, `PickList`, `PackStation`, `Replenishment`, `CycleCounts/CycleCountPlanner/CountSession/CountReview`, `LoadingManifests/Planner/LoadingBay`, `DockSchedule/AppointmentPlanner`, `QCQueue/QCInspectionDetail`, `Slotting`, `YardBoard`, `LabourBoard`, `BillingBoard`, `CrossdockBoard`.
Master pages: `WarehousesList/New/Edit/View`, `WarehouseLayoutPage`, `LicensePlates/View`, `CartonTypes`.

### A.2 What is genuinely wired vs. thin
- Solid substrate: `stock_movements`, `stock_quants`, `stock_lots`, `stock_serials`, `cost_layers`, `stock_locations` (with `structure_level/barcode/pick_sequence`), `wms_license_plates`, `wms_tasks`, `warehouses`, `business_event_outbox` with `wms.<entity>:<id>:<state>` idempotency (ADR 0079 §3).
- Phased tables exist: `wms_count_sessions/lines`, `warehouse_docks`, `receiving_appointments`, `pick_waves`, `pack_stations`, `shipment_packages`, `loading_manifests`, `qc_inspections`.
- Hardware chokepoint: `src/services/hardware/HardwareClient.ts` → `execForIntent` → `resolve_device` RPC → agent/Electron FIFO; scanner kernel at `src/services/scanner/*` (bus + router + feedback).
- Realtime provider mounted globally (`RealtimeSyncProvider`) but currently biased to finance-critical tables; WMS boards are not yet on the unified channel.

### A.3 Gaps observed
1. **No first-class Receiving module.** ASN → unload → GRN discrepancy is spread across `AppointmentPlanner`, ad-hoc `ReceiveToWMSDialog`, and Inventory-side goods receipts.
2. **No dedicated Returns/RMA execution surface** on the WMS side; disposition (return-to-stock/scrap/QC-hold) is implicit.
3. **Operator tasks is a generic list, not a polymorphic task engine.** No typed task payloads (putaway/pick/count/replen/qc/loopback), no assignment/claim/heartbeat, no offline queue.
4. **Event catalog is implicit.** `warehouse.*` topics exist but there is no published contract (name, payload schema, producers, consumers, idempotency key shape) beyond the ADR bullets.
5. **State machines are not codified.** LP, appointment, wave, pick, pack, manifest, QC, count-session transitions live in page code and RPCs — not in a single guarded FSM per aggregate.
6. **Concurrency safety is uneven.** No consistent optimistic-lock / row-version story for LP moves, bin claims, wave allocation, or count-line capture from multiple operators.
7. **Hardware coverage is receipt/label-centric.** Phone-as-scanner works via kernel, but there is no unified "scan intent" contract per WMS screen, no standard label templates for LP/bin/shipping under `document_templates` + `document_template_ast`, no batched label print queue tied to `wms_tasks`.
8. **Realtime UX is missing on operational boards** (dock schedule, yard, wave, loading bay, QC queue). They fetch-and-poll instead of subscribing to `wms_*` postgres_changes + outbox echoes.
9. **Cross-dock, slotting, labour, 3PL billing** pages exist but do not consume the same event stream — they read snapshots.
10. **Exception handling is scattered** — receiving discrepancies, QC fails, short-picks, count variances all diverge instead of routing into one Exception Queue with typed resolutions.

### A.4 Canonical entity/state inventory (target)
- **Facility**: warehouse → zone → aisle → rack → shelf → bin (existing `stock_locations` with `structure_level`).
- **LPN** (`wms_license_plates`): `draft → receiving → putaway → stored → picked → packed → staged → loaded → shipped | quarantined | consumed | voided`.
- **Appointment** (`receiving_appointments`): `requested → confirmed → arrived → docked → unloading → unloaded → closed | no_show | cancelled`.
- **Trailer/Yard visit**: `expected → on_site → at_dock → released`.
- **GRN**: `open → in_progress → posted → discrepant → closed`.
- **QC inspection**: `pending → in_progress → passed | failed | conditional → closed`.
- **Putaway task / Pick task / Replen task / Count task / QC task** (all rows in `wms_tasks` with typed payload): `available → claimed → in_progress → completed | cancelled | exception`.
- **Wave** (`pick_waves`): `planned → released → in_progress → picked → completed | cancelled`.
- **Pack** (`shipment_packages`): `open → sealed → labeled → staged | voided`.
- **Manifest / Load** (`loading_manifests`): `planned → loading → verified → dispatched | rejected`.
- **Count session**: `planned → counting → recount → variance_review → posted | cancelled` (WMS side; Inventory posts adjustments per ADR 0080 §Cycle count).

### A.5 End-to-end event flows (target contract)
Each event lands on `business_event_outbox` with `topic = warehouse.<aggregate>.<transition>`, `idempotency_key = wms.<aggregate>:<id>:<state>`, payload = `{ aggregate_id, warehouse_id, branch_id, actor_id, device_id, occurred_at, before, after, correlation_id }`.

Inbound: `purchase.order.confirmed` → `warehouse.appointment.requested → .confirmed → .arrived → .docked` → `warehouse.unload.started → .completed` → `warehouse.lpn.created` (per LP) → `warehouse.grn.line.captured` → `warehouse.qc.triggered? → .passed|.failed` → `warehouse.putaway.task.generated → .claimed → .completed` → Inventory consumes and posts `stock.movement` (receipt).

Storage/Control: `warehouse.count.session.planned → .counting → .completed` → Inventory materialises `physical_counts` (ADR 0080). `warehouse.replenishment.threshold_hit → .task.generated → .completed`. `warehouse.slotting.reslot.recommended → .task.generated → .completed`.

Outbound: `sales.order.released` → `warehouse.wave.planned → .released` → `warehouse.pick.task.generated → .claimed → .completed | .short` → `warehouse.pack.opened → .sealed → .labeled` → `warehouse.manifest.planned → .loading → .verified → .dispatched` → Inventory consumes `stock.movement` (issue).

Returns: `sales.return.authorized` → `warehouse.return.appointment.*` → `warehouse.return.received` → `warehouse.qc.triggered` → disposition `warehouse.return.disposition.{restock|scrap|repair|vendor}` → Inventory posts adjustment.

Cross-dock: on `warehouse.grn.line.captured`, if an open pick reservation matches, emit `warehouse.crossdock.matched` → skip putaway, generate `pack.task` directly on staging lane.

Ancillary streams: `warehouse.labour.task.time.captured` (feeds Labour). `warehouse.billing.activity.recorded` (feeds 3PL Billing per ADR 0082-wms).

---

## Part B — Phased roadmap

### Phase 1 — Formalize the domain (architecture & event model)
Objectives: name the aggregates, publish the event catalog, codify FSMs, close module gaps.

**Status: ✅ COMPLETE (Phases 1.1–1.4 shipped 2026-07-29).**

Delivered:
1. ✅ **ADR 0101** (`docs/adr/0101-wms-domain-and-event-catalog.md`) — aggregates, FSM guards, event catalog, idempotency key contract.
2. ✅ **Event topic catalog** — SQL table `wms_events_catalog` (seeded) + TS constants `src/features/warehouse/events/topics.ts`. All producers/consumers reference constants, not raw strings.
3. ✅ **Server-side transition guards (SECURITY DEFINER + row_version optimistic lock + outbox emit):**
   - `wms_transition_task` + `wms_claim_next_task` (SKIP LOCKED) + `wms_task_heartbeat` + `wms_task_reap_expired`
   - `wms_transition_lpn`
   - `wms_transition_receiving`
   - `wms_transition_return`
   - `wms_raise_exception` + `wms_resolve_exception`
   - Shared `_wms_emit_outbox` helper writes `warehouse.<aggregate>.<transition>` events with canonical `wms.<aggregate>:<id>:<state>` idempotency keys.
4. ✅ **Three new bounded contexts wired end-to-end:**
   - **Receiving Sessions** (`/warehouse-app/receiving`) — `open → unloading → captured → posted → closed` (+ discrepant, cancelled).
   - **Return Orders** (`/warehouse-app/returns`) — `draft → authorized → in_transit → received → inspecting → disposed → closed` (+ cancelled). Disposition (return_to_stock / quarantine / scrap / refurbish) carried in outbox payload.
   - **Exceptions Inbox** (`/warehouse-app/exceptions`) — `open → acknowledged → investigating → escalated → resolved | wont_fix` triage surface, wired to `wms_resolve_exception`. `wms_raise_exception` callable from any code path.
5. ✅ **Polymorphic task engine** — `wms_tasks` with `row_version`, `payload`, `assignee_user_id`, `lease_expires_at`, priority/SLA. UI (`OperatorTasks`) fully migrated off direct `.update()` onto `useTaskEngine` (claim / claim-next / transition / heartbeat / reap). Cancel flow can optionally raise a `stale_task` exception.
6. ⏳ **Module ownership matrix** (`docs/architecture/WMS_MODULE_OWNERSHIP.md`) — deferred; roll into Phase 2 documentation pass.

Direct `.update({ state })` calls on `wms_tasks` and `wms_license_plates` from page code have been swept. All state mutations now flow through the guarded RPCs.


### Phase 2 — Hardware & real-time integration
Objectives: one scan contract, one label pipeline, one live event stream to every board.
Steps:
1. Define **Scan Intents** per screen (`receiving.lpn`, `receiving.item`, `putaway.bin`, `putaway.lpn`, `pick.location`, `pick.item`, `pack.carton`, `load.lpn`, `count.location`, `count.item`, `qc.lpn`). Register them in `src/services/scanner/scanRouter.ts` so the same phone/BT/USB path lights the correct handler per screen.
2. Standard label templates via `document_templates` + `document_template_ast` (ADR 0084/0085/0090):
   - `wms.label.lpn` (128x, GS1 AI 00 SSCC-style),
   - `wms.label.bin` (Code 128 + human aisle-rack-shelf-bin),
   - `wms.label.shipping` (carrier-agnostic + optional carrier overlay),
   - `wms.label.packing_slip`.
   Ownership stays in the print pipeline (`src/services/printing/dispatch.ts` → `toDevice`), no new hardware seam.
3. Central **print queue tied to tasks**: on `warehouse.lpn.created`, `warehouse.pack.labeled`, `warehouse.manifest.verified`, publish a `print.job.requested` outbox row consumed by the label printer bound to the active branch device via `resolve_device`. Reprints emit `print.job.reprint.requested` with `is_reprint=true`.
4. **Realtime board fabric**: extend `useUnifiedRealtimeSync` (or add `useWmsRealtimeSync`) to subscribe to `wms_tasks`, `wms_license_plates`, `receiving_appointments`, `pick_waves`, `shipment_packages`, `loading_manifests`, `qc_inspections`, `wms_count_sessions`. All operational pages switch from polling to `useEffect` + `supabase.channel().on('postgres_changes', …)` with cleanup, per the codebase realtime rule.
5. **Concurrency**: add `row_version int not null default 0` on every mutable WMS aggregate + optimistic-lock check inside each `_wms_*_transition` function. Task claim uses `SKIP LOCKED`. Count-line capture uses `INSERT … ON CONFLICT (session_id, location_id, product_id, lot_id, serial_id) DO UPDATE` with per-operator attribution rows.
6. **Offline / mobile** operator flow: local IndexedDB queue in the phone browser for pending scans; replay on reconnect using idempotency keys derived from `(device_id, client_scan_id)`.

### Phase 3 — Per-module deep improvements
For each module: (a) problem, (b) objective, (c) concrete steps.

**Operator tasks** — Generic list; no claim/heartbeat.
Objective: single polymorphic queue driving every operator screen.
Steps: implement Phase 1 §5 engine; add `MyTasks` mobile view (claim → work → confirm → next); auto-release on heartbeat lapse; per-zone/skill routing.

**Putaway** — No slotting-aware destination; validation weak.
Steps: destination suggested by Slotting rules (velocity + affinity + zone constraints); scan LPN → scan bin → server validates capacity/zone → transition; on mismatch emit exception; log labour time.

**Wave planner** — Rules and allocation ad-hoc.
Steps: wave-rule table (`priority`, `carrier`, `cutoff`, `zone`, `order_count_max`, `weight_max`); allocation transaction reserves inventory via `stock_quants` reservation columns; explicit `pick_wave_lines`; release emits pick tasks.

**Replenishment** — Thresholds unclear.
Steps: `replen_rules` per (bin, product) with min/max/target; trigger = quant drop below min; task generated with source pallet bin; scan source → scan destination pick-face → transition.

**Cycle counts** — WMS/Inventory bridge exists (ADR 0080) but no scan-first execution polish.
Steps: session planner supports ABC/random/zone/velocity strategies; blind + recount modes; per-line operator attribution; on `completed`, outbox event materialises `physical_counts` in Inventory; variance review UI links both sides.

**Dispatch (Pick/Pack/Manifest/Load)** — Fragmented.
Steps: unified pipeline Wave → Pick tasks → Pack station (scan carton → scan items → seal → label) → Manifest planner (dock, carrier, cutoff) → Loading bay (scan LPN into trailer, verify count == manifest); on `verified` emit `warehouse.manifest.dispatched` → Inventory issues.

**Dock schedule & Yard** — Present but not linked to appointments cleanly.
Steps: dock capacity model (windows × doors); appointment auto-suggests door; yard tracks trailer status; both boards subscribe to `receiving_appointments` and `yard_visits` realtime.

**Quality control** — Checklists and dispositions loose.
Steps: `qc_policies` per product/vendor/route (inbound/return/production); checklist templates; `qc_inspections` with pass/fail/conditional and disposition action (accept | quarantine | reject | rework); hold LPN via `wms.lpn.status = quarantined`; disposition emits Inventory event.

**Slotting** — Static.
Steps: slotting rules engine (velocity class, product family affinity, weight, temperature, hazmat, ergonomics); scheduled recompute → generates `move` tasks; operators execute like putaway.

**Labour** — No time capture.
Steps: task lifecycle emits `.claimed/.completed` with duration; `labour_activities` roll up per operator per shift; supervisor board shows throughput, idle, exception rate.

**3PL Billing** — Not event-driven.
Steps: per ADR 0082-wms, subscribe to warehouse events; `billing_activities` rows keyed by `(client, activity_type, uom)`; rate cards; period close emits invoice draft to Finance.

**Cross-dock** — Board exists.
Steps: on `warehouse.grn.line.captured`, check open sales reservations; if match, skip putaway and emit `warehouse.crossdock.matched` → pack task at staging lane; UI shows matches live.

**Master (Warehouse / Layout / LPN / Cartons)** — Solid per ADR 0079/0080.
Steps: add barcode print for zones/bins from layout editor; carton catalogue linked to pack-station cartonization; LP page adds bulk-print + reprint audit.

### Phase 4 — UX & error-proofing
1. Role-based dashboards: Inbound Controller, Outbound Controller, QC Lead, Shift Supervisor, Operator (mobile). Each is a live board subscribing to the relevant slice.
2. Mobile operator UX: full-screen scan target, big feedback (audio+haptic via `scanFeedbackBus`), one-thumb confirm, offline queue banner.
3. Guided flows: every scan step declares expected intent; unexpected scans surface a typed error via `scanFeedbackBus` instead of silent no-op.
4. Exception queue triage screen with typed resolutions writing back guarded transitions.
5. Audit: every state transition already writes an outbox row; add an `audit_logs` mirror per aggregate for human-readable timeline in the LP/Appointment/Wave/Pack detail views.
6. Validation everywhere it matters: bin capacity, zone/product compatibility, lot/serial required, LP not already shipped, pick source has stock, load count matches manifest, count session has no open lines before post.

---

## Technical section (for engineers)

- **New tables (Phase 1):** `wms_events_catalog` (metadata), `wms_returns_appointments`, `wms_return_lines`, `wms_exceptions`, `wms_replen_rules`, `wms_slotting_rules`, `wms_labour_activities`, `wms_billing_activities`, `wms_wave_rules`, `wms_pick_wave_lines`. Every table follows the four-step migration structure (CREATE → GRANT → ENABLE RLS → POLICY), scoped by `business_id` + `warehouse_id`, with `_wms_*_transition` triggers and row-version columns.
- **Realtime**: `ALTER PUBLICATION supabase_realtime ADD TABLE …` for each new aggregate; RLS remains scoped so subscribers only see rows in their branch.
- **Server functions** (`createServerFn`, per stack rules): `claimTask`, `transitionLpn`, `postCountSession`, `releaseWave`, `verifyManifest`, `raiseException`, `resolveException`. All under `src/lib/warehouse/*.functions.ts`, with `.middleware([requireSupabaseAuth])`. Callers use `useServerFn` — never in public loaders.
- **Server routes** under `src/routes/api/public/*` only for external ASN/carrier webhooks with HMAC verification per platform rules.
- **Client**: TanStack Query with `queryOptions` + `ensureQueryData` loaders + `useSuspenseQuery`. Realtime hooks in `useEffect` with `removeChannel` cleanup.
- **Hardware**: no new chokepoint; all print/scan via `hardwareClient` + `scanRouter`. New label templates land in the document artifact pipeline (ADR 0084).
- **Testing**: architecture guards for topic constants, FSM edge coverage, no direct writes to protected aggregates outside their transition functions; Playwright E2E per lifecycle (`docs/wms/e2e-harness.md`).

## Non-goals
- No changes to Inventory writers, valuation, cost layers, POS, Finance, Localization.
- No new hardware seam or preload API.
- No changes to `warehouses` table ownership (remains Warehouse app per ADR 0080).

## Deliverables per phase
- Phase 1: ✅ ADR 0101, event catalog module (SQL + TS), FSM SQL functions (task/LPN/receiving/return/exception + raise/resolve), three new bounded contexts (Receiving, Returns, Exceptions) live in nav/routes, polymorphic task engine wired end-to-end.
- Phase 2: scan intent registry, four label templates, print queue integration, WMS realtime hook, row-version + offline queue.
- Phase 3: per-module upgrades listed above.
- Phase 4: role dashboards, mobile operator shell, exception triage, audit timelines, validation pass.

---

## Execution ledger & handoff

### Currently active phase
**Phase 2 — Hardware & real-time integration.** Phase 1 is closed.

### What ships in this repo right now (verified)
- DB: `wms_transition_{task,lpn,receiving,return}`, `wms_{claim_next_task,task_heartbeat,task_reap_expired,raise_exception,resolve_exception}`, `_wms_emit_outbox`. Tables `wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `wms_events_catalog`, `wms_replen_rules`, `wms_slotting_rules` (created in Phase 1.1) with row_version + FSM enums (`wms_task_state`, `wms_lpn_status`, `wms_receiving_state`, `wms_return_state`, `wms_exception_state`, `wms_exception_kind`).
- TS: `src/features/warehouse/events/topics.ts` (WMS_TOPIC + idempotencyKey + TASK_TYPES/TASK_STATES), `src/features/warehouse/tasks/useTaskEngine.ts`.
- Pages migrated to guarded RPCs: `OperatorTasks.tsx`, `LicensePlateView.tsx`, `ExceptionsInbox.tsx`, plus new `ReceivingSessions.tsx` and `ReturnOrders.tsx`. All wired in `src/apps/warehouse/routes.tsx` + `src/apps/warehouse/nav.ts`.
- ADR: `docs/adr/0101-wms-domain-and-event-catalog.md`.

### Still pending inside Phase 1 (deferred to Phase 2 doc pass)
- `docs/architecture/WMS_MODULE_OWNERSHIP.md` — the who-writes-what/who-subscribes-to-what matrix. Small doc job; folded into Phase 2 §1 kickoff.
- Sweep the remaining pages that still do direct `.update({ state })` on WMS aggregates (`PutawayQueue`, `WavePlanner`, `PickList`, `PackStation`, `LoadingBay`, `QCQueue`) — those aggregates get transition RPCs during Phase 2 §5 (concurrency pass). They are functionally correct today but not yet FSM-guarded.

### Next agent — start here (in order)

**Step 0 (mandatory verification, before writing any code).**
1. Re-read `docs/adr/0101-wms-domain-and-event-catalog.md` and this section.
2. Confirm the RPCs exist and are grant-scoped correctly:
   `SELECT proname FROM pg_proc WHERE proname IN ('wms_transition_task','wms_transition_lpn','wms_transition_receiving','wms_transition_return','wms_raise_exception','wms_resolve_exception','wms_claim_next_task','wms_task_heartbeat','wms_task_reap_expired','_wms_emit_outbox');`
3. Open `OperatorTasks`, `LicensePlateView`, `ReceivingSessions`, `ReturnOrders`, `ExceptionsInbox` in the preview and walk one transition per page. Every state change must land in `business_event_outbox` with topic `warehouse.<aggregate>.<state>` and idempotency key `wms.<aggregate>:<id>:<state>`. If any page still calls `supabase.from(...).update({ state })` directly, that's a Phase 1 regression — fix before proceeding.
4. Run `bunx tsgo --noEmit` and confirm zero errors introduced by Phase 1 files.

**Step 1 — Phase 2.1: Scan Intent registry.**
Define the scan-intent contract in `src/services/scanner/scanRouter.ts` and add per-screen registrations for the intents listed in Part B §Phase 2 step 1. Every WMS screen declares its expected intent on mount; unexpected scans surface a typed error via `scanFeedbackBus` (never a silent no-op).

**Step 2 — Phase 2.2: Standard label templates.**
Author the four `document_templates` + AST rows (`wms.label.lpn`, `wms.label.bin`, `wms.label.shipping`, `wms.label.packing_slip`) via the document-template pipeline. Do NOT hand-render — reuse the existing barcode/PDF engine per ADR 0084/0085.

**Step 3 — Phase 2.3: Realtime board fabric.**
Add `useWmsRealtimeSync` mirroring `useInventoryRealtime` structure: subscribe (in `useEffect` with `removeChannel` cleanup) to `wms_tasks`, `wms_license_plates`, `wms_exceptions`, `wms_receiving_sessions`, `wms_return_orders`, `receiving_appointments`, `pick_waves`, `shipment_packages`, `loading_manifests`, `qc_inspections`, `wms_count_sessions`. Channel narrowed by `business_id`. Invalidate matching query keys with `refetchType: 'active'`.

**Step 4 — Phase 2.4: Concurrency sweep.**
Add `wms_transition_{wave,pack,manifest,qc,count_session}` RPCs following the same shape as `wms_transition_receiving`. Migrate `WavePlanner`, `PackStation`, `LoadingBay`, `QCQueue`, `CountSession` off direct updates onto the new RPCs.

### Operating rules for the next agent
- **Chronological.** Do not skip ahead to Phase 3/4 modules until every Phase 2 step above is production-ready.
- **No shallow scaffolds.** Each step must ship the DB migration + typed TS wrapper + at least one page consuming it + a working transition demonstrated in the preview.
- **Never** write `state` directly to a WMS aggregate — always through its `wms_transition_*` RPC.
- **After each sub-phase completes:** update this "Execution ledger" section (move items from pending to shipped, advance the "currently active" pointer, refresh the "Next agent — start here" list) so the plan remains the authoritative status source.

