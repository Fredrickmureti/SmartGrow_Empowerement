# WMS Continuation Plan — Round 4 (verified handoff)

## Phase 0 — Verification results

I re-ran the previous engineer's claims against the code and DB rather than trusting the ledger. Findings:

### Genuinely green (evidence)
- Ownership doc `docs/architecture/WMS_MODULE_OWNERSHIP.md` present.
- `wms-outbox-parity.test.ts` and `wms-topic-vocabulary.test.ts` pass (9 tests).
- `pg_cron` job `wms-task-lease-reaper` scheduled `* * * * *`, `active=true`.
- 24 WMS aggregate/master pages and 8 mobile RF pages present as claimed.
- `WMS_TOPIC` includes the new state-based QC topics (`warehouse.qc.pending|passed|failed|conditional|closed|cancelled`).

### FALSE / contradictory (now pending)
1. **"Full `wms-*` suite green" is wrong.** Running all 24 `wms-*` guards: **1 failure** — `wms-phase7` still requires `warehouse.qc.opened|accepted|rejected|cancelled` in `domainEventBus.ts` and `BusinessSagaMount.tsx`, but Phase 2.6 deliberately retired that legacy vocabulary in favour of trigger-emitted state topics. Guard and implementation contradict each other. Same class of drift the plan warned against in its own operating rules.
2. **Cross-dock (N8) still lacks the receiving-line subscriber.** `warehouse.receiving.line_captured` has no consumer in `BusinessSagaMount.tsx` or `domainEventBus.ts`. Board is still operator-triggered only, as previously flagged.
3. **Offline replay idempotency** (Phase 2.5 §3) still unproven — no mobile-queue replay test.
4. **UX artifacts absent** — no `<OutboxTimeline>`, no contention toast, no typed `resolution_kind` enum on `wms_exceptions`, no SLA `due_by` column, no unified scan-feedback layer.
5. **E2E specs under `e2e/wms/` and `e2e/wm/`** are still scaffolds without real assertions.

### Corrected resume point
**Phase 2.7 — reconcile Phase 7 guard with the unified vocabulary**, then chronologically **Phase 3 (module deep-dives)** starting with QC + Cross-dock (the two remaining event-fabric gaps), then Receiving → Putaway, Replenishment, Yard/Trailer FSM, Labour/3PL re-metering, and finally Phase 4 UX.

---

## Phase 2.7 — Guard reconciliation (blocker) — ✅ DONE

- `wms-phase7.test.ts` rewritten to derive the QC topic expectation from `WMS_TOPIC` (mirrors the technique used by `wms-topic-vocabulary`), and to assert the bus/saga consume the topics module rather than string-matching a retired vocabulary.
- Generic guard `wms-domain-bus-topic-parity.test.ts` added: pins that `domainEventBus.ts` imports `WmsTopic`, that `BusinessSagaMount.tsx` iterates `Object.values(WMS_TOPIC)`, that `WMS_TOPIC` has no duplicates, and that every value is a `warehouse.*` topic.
- No code changes needed in `domainEventBus.ts` / `BusinessSagaMount.tsx` — both already consume `WMS_TOPIC` dynamically (Phase 2.6 landed the dynamic registration loop); only the hard-coded guard was drifting.
- **Full `wms-*` suite: 25 files / 94 tests green** (verified this turn).

## Phase 3.3 — Receiving line-captured emission — ✅ DONE

- New trigger `trg_wms_recv_lines_emit_captured` on `public.wms_receiving_lines` (AFTER INSERT OR UPDATE OF `received_qty`) invokes `_wms_emit_receiving_line_captured`, which publishes `warehouse.receiving.line_captured` to `business_event_outbox` via `_wms_emit_event`. Idempotency key `wms.receiving_line:{id}:captured`.
- Payload includes session/product/lpn/lot/serial/uom/qty/staging + upstream `source_doc_type|id`, appointment, dock — everything downstream cross-dock / put-away / replenishment needs without a follow-up query.
- Skips zero/negative quantities and no-op quantity updates.

## Phase 3.2 — Cross-dock subscriber — ✅ DONE

- Schema: `wms_crossdock_opportunities` now accepts either `grn_line_id` (legacy GRN-close path) or `receiving_line_id` (new per-line path). `wms_crossdock_source_present` CHECK enforces one-of; per-source partial unique indexes replace the old single unique.
- New RPC `evaluate_crossdock_on_receiving_line(uuid)` picks the oldest open sales-order line for the same business+product, inserts the opportunity, and emits `warehouse.crossdock.matched` via `emit_crossdock_event`.
- `BusinessSagaMount` subscribes `WMS_TOPIC.RECEIVING_LINE_CAPTURED` and calls the RPC with the receiving-line id from the event payload.
- Guard `wms-crossdock-subscriber.test.ts` pins topic + RPC + payload param, so refactors can't silently unwire N8.
- Verified: 5 relevant guard files / 19 tests green.

## Phase 3.1 — QC lifecycle (typed resolution) — ✅ DONE

- New enum `public.qc_resolution_kind` (accept, reject_return_to_supplier, reject_scrap, conditional_release, rework, use_as_is).
- `wms_qc_inspections.resolution_kind` + `resolution_notes` columns added and backfilled from legacy free-text `disposition`.
- `accept_qc_inspection` stamps `accept` (full) or `conditional_release` (partial); `reject_qc_inspection` maps disposition → typed enum without changing existing stock-move / RTV / scrap side effects.
- `wms_transition_qc` now accepts optional `resolution_kind` / `resolution_notes` in the payload (only on `passed|failed|conditional|closed`), validates against the enum, stamps the row, and includes the resolution in the emitted `warehouse.qc.<state>` outbox event so downstream consumers (inventory hold release, supplier-claim automation) can branch on a typed value.
- Verified: full `wms-*` guard suite — **26 files / 97 tests green**.

## Phase 3.4 — Event-driven replenishment — ✅ DONE

- `_wms_maybe_enqueue_replen(product, location)` evaluates matching active pick-face rules, skips when open replen task exists or source empty, otherwise inserts a `replenish` task and publishes `warehouse.replen.enqueued` via `_wms_emit_outbox`.
- Trigger `trg_stock_quants_replen` on `stock_quants` (AFTER INSERT OR UPDATE OF quantity, reserved_quantity) invokes the helper; the "Generate" button is now a redundant manual fallback.
- Idempotency: outbox key `wms.replen:{product}:{pick_location}:{minute_bucket}` collapses noisy stock-quant churn to one event per minute per pick face.
- Topic registered in `WMS_TOPIC.REPLEN_ENQUEUED`, `wms_events_catalog`, and `WMS_MODULE_OWNERSHIP.md`; bus + saga pick it up via the existing `Object.values(WMS_TOPIC)` loop.
- Verified: full `wms-*` guard suite — **26 files / 97 tests green**.

## Phase 3.5 — Yard / trailer FSM (next)



---

## Phase 3 — Module deep-dives (dependency-first order)

Each module ships a standard vertical: **migration → transition RPC (with trigger-owned emission) → typed hook wrapper → page consumption → realtime subscription → Playwright spec with real assertions → guard test**.

### 3.1 QC lifecycle
- Add typed `qc_resolution_kind` enum (`accept`, `reject_return_to_supplier`, `reject_scrap`, `conditional_release`, `rework`).
- `wms_qc_inspections.resolution_kind` + `resolution_notes`; migrate free-text `resolution` values.
- Wire QC pass → `warehouse.qc.passed` → Inventory hold release; QC fail → inventory quarantine hold via existing `stock_quants` status column.
- Purchasing claim hook: `warehouse.qc.failed` for goods-receipt-linked inspections opens a supplier-claim draft.

### 3.2 Cross-dock (closes N8)
- Subscribe `warehouse.receiving.line_captured` in `BusinessSagaMount`; match against open sales/transfer allocations; on match, INSERT into `wms_crossdock_opportunities` and emit `warehouse.crossdock.matched`.
- On operator accept, short-circuit putaway task generation (skip putaway, create pack/stage task directly).
- Guard: `wms-crossdock-subscriber.test.ts` asserts the saga handler exists.

### 3.3 Receiving → Putaway coherence
- Finish ASN → GRN → putaway task fan-out inside a single receiving-session commit.
- Slotting-rule-driven destination ranking (`wms_slotting_rules` already exists) with scan-guarded bin validation on the mobile Putaway screen.
- Every LP capture emits `warehouse.lpn.created`; every completed putaway emits `warehouse.putaway.completed` via trigger.

### 3.4 Replenishment
- Replace manual generation button with event trigger: subscribe `stock_quants` change events (postgres trigger → outbox), evaluate `wms_replen_rules`, generate replenishment tasks when pick-face below min.
- Idempotency key `wms.replen:{item}:{bin}:{trigger_ts_bucket}` to collapse duplicate triggers.

### 3.5 Yard / trailer FSM
- Formalise trailer state machine (`expected → arrived → docked → unloading|loading → departed`) using the same transition-RPC + trigger-emit pattern already used for wave/manifest/QC.
- Emissions now come from `_wms_emit_state_change` on `wms_trailer_visits` (trigger already exists per Phase 2.4 §5); RPC bodies stop emitting.
- Dock schedule realtime board reads outbox events for live truck lifecycle.

### 3.6 Labour / 3PL billing re-metering
- Backfill `_wms_map_event_to_activity` counters over the full outbox stream now that all lifecycle facts publish.
- Nightly reconciliation job compares billed activities vs outbox counts per 3PL client; drift emits `warehouse.billing.drift`.

### 3.7 Wave / Pick / Pack / Dispatch
- Hardening only: add real Playwright assertions, no schema changes.
- Load verification enforces full scan-out before manifest can transition to `dispatched`.

### 3.8 Offline mobile replay idempotency
- Playwright + IndexedDB harness: enqueue the same `(device_id, client_scan_id)` twice while offline, come online, assert exactly one outbox row.

---

## Phase 4 — UX & error-proofing

- **OutboxTimeline component**: `<OutboxTimeline aggregate={"wave"} id={id} />` reads `business_event_outbox` filtered by `wms.<aggregate>:<id>:` prefix. Reused on LPN, wave, manifest, QC, count, receiving-session detail pages.
- **Typed exception triage**: add `resolution_kind` enum column + `due_by` timestamptz to `wms_exceptions`; ExceptionsInbox page grouped by SLA breach.
- **Contention toast** (N10): realtime subscriber on `wms_tasks.claimed_by` change compares against current `assignee_user_id`; if another operator claims a task I am viewing, show toast + auto-return to queue.
- **Unified scan feedback**: single `useScanFeedback()` hook (audio + haptic + visual) consumed by Receive, Putaway, Pick, Pack, Load, Count, QC mobile screens.
- **Two-context realtime Playwright smoke** (moved from Phase 2.3 §5): open two browser contexts, transition an aggregate in one, assert the other's UI updates without reload.
- **De-scaffold** the seven `e2e/wms/` and `e2e/wm/` specs into real assertions, one per module vertical.
- **Role-based real-time dashboards**: inbound, outbound, inventory, tasks, exceptions — all fed by the outbox subscription layer, no per-table polling.

---

## Operating rules (unchanged, restated)

- Never write `state`/`status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Run the entire `wms-*` guard suite (24 files) before declaring a phase green.
- When a modern implementation replaces a legacy one, delete the legacy path in the same change.
- Update the ledger with evidence (query output, test output), not assertions.

---

## Technical details (for the implementing engineer)

- Failing test: `src/test/architecture/wms-phase7.test.ts:57` — hard-codes `["opened","accepted","rejected","cancelled"]`. Replace with a loop over `Object.entries(WMS_TOPIC).filter(([k]) => k.startsWith("QC_"))`.
- `BusinessSagaMount.tsx` currently registers only the legacy QC topic strings; add the six new state topics with placeholder handlers so both guard and DB catalog agree.
- Cross-dock subscriber: add case for `warehouse.receiving.line_captured` in `BusinessSagaMount.tsx` calling a new `handleReceivingLineCaptured` in `src/features/warehouse/crossdock/`.
- Enum migration example: `CREATE TYPE public.qc_resolution_kind AS ENUM (...); ALTER TABLE public.wms_qc_inspections ADD COLUMN resolution_kind qc_resolution_kind;` + backfill from the free-text `resolution` values via `CASE` mapping, then `NOT NULL` in a follow-up migration once backfilled.
- Replenishment trigger: `AFTER UPDATE OF quantity ON public.stock_quants` calling `_wms_maybe_enqueue_replen(NEW.item_id, NEW.location_id)`; helper INSERTs into `wms_tasks` with dedupe on `idempotency_key`.
- Trailer FSM: reuse `_wms_emit_state_change` allow-list; extend catalog with `warehouse.trailer.unloading` / `.loading` if not already present.
- OutboxTimeline query: `select event_type, payload, created_at from business_event_outbox where idempotency_key like $1 order by created_at`.
