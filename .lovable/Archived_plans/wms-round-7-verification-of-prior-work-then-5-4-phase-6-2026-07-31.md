# WMS — Round 7: verification of prior work, then 5.4 → Phase 6

## Phase 1 — Independent verification (done this turn, by execution not assumption)

| Prior claim | Verdict | Evidence |
|---|---|---|
| 5.1 desktop replay safety | **Confirmed** | `wms-client-scan-id-unique.test.ts` (11 tests) passes, including "no mutating bare `supabase.rpc` in desktop WMS modules" and whitelist parity. |
| 5.2 trailer no-show → labour reclaim | **Confirmed** | `wms-noshow-labour-reclaim.test.ts` present and green; `LABOUR_RECLAIMED` topic declared in `topics.ts`. |
| 5.3 orphan-module guard + `CancelAggregateButton` | **Confirmed structurally** | `wms-no-orphan-modules.test.ts` present and green. |
| "33 guard files / 142 tests green, typecheck clean" | **Confirmed** | `bunx vitest run src/test/architecture/wms-*.test.ts` → 33 files, 142 tests, all passing. (34 files listed on disk; one is the shared `wmsGuardUtils.ts` helper, not a spec.) |
| 5.4 3PL billing coverage "next / untouched" | **Partly stale — most of it already shipped** | Migration `20260729092007` already rewrote `_wms_map_event_to_activity` onto canonical topics (`warehouse.receipt.staged`, `warehouse.task.completed` + `task_type`, `warehouse.manifest.dispatched`, `warehouse.trailer.departed`, `warehouse.qc.passed/failed`, `warehouse.count.posted`) and catalogued the missing topics. |
| 5.5 receiving E2E | **Open** | `e2e/wms/receive.spec.ts` still carries the `TODO(14a.2)` header comment; needs a read-through to decide close vs. keep. |

### Genuinely open gaps found by this audit

1. **Storage-day billing has a UI but no producer.** `BillingBoard.tsx` offers `storage_lpn_day` as a tariff activity, but `storage_lpn_day` appears nowhere else in `src/` or `supabase/` — no event, no mapper branch, no accrual. Any 3PL that prices storage silently invoices zero. Storage is time-based, so it cannot come from the outbox; it needs a daily accrual.
2. **No completeness guard on billable topics.** `wms-topic-catalog-sync.test.ts` only checks TS↔SQL topic parity; nothing asserts that every billable activity has a producer, so gap (1) was invisible to CI.
3. **No cross-dock E2E.** `wms-crossdock-subscriber.test.ts` exists; `e2e/wms/crossdock.spec.ts` does not. Inbound→outbound bypass is the highest-risk untested flow.
4. **Label "queue" is a thin wrapper.** `src/features/warehouse/labels/wmsLabels.ts` is a single pass-through to `PrintService.printLabel` — no queue, no retry, no operator-visible failure surface for a dead label printer mid-pick.
5. **Exception SLA is passive.** `due_by` is read in `ExceptionsInbox`/dashboards but nothing escalates a breach.
6. **No inventory reconciliation guard** proving WMS movements always land as canonical Inventory ledger effects (ADR 0079).

## Phase 2 — Work plan

### 5.4 3PL billing completeness (resume here)
- **Storage accrual**: migration adding `wms_accrue_storage_days(p_business_id, p_as_of date)` — one `storage_lpn_day` billable row per (client, warehouse, day) derived from LPNs in a `stored` state at the cut-off, keyed idempotently on `(business_id, activity, client, warehouse, day)` so re-runs are safe. Expose a "Accrue storage to date" action on `BillingBoard` next to the existing capture button, and register it for scheduled invocation.
- **Guard**: extend `wms-topic-catalog-sync.test.ts` with a billable-completeness assertion — every activity in `BillingBoard.ACTIVITIES` must either appear in a `_wms_map_event_to_activity` branch or in the accrual function. This is the test that would have caught the storage gap.
- Verify the mapper's canonical topics are actually emitted with the payload keys it reads (`task_type`, `client_business_id`, `quantity`) — a mapper branch that never matches is the same defect in a different place.

### 5.5 Receiving E2E closure
- Read `e2e/wms/receive.spec.ts` end to end. If it drives PO → receipt → LPN → putaway task from the UI, delete the stale `TODO(14a.2)` header and record it closed. If it still short-circuits into `create_goods_receipt`, drive the receipt from the Receiving screen instead.

### Phase 6 (in order, one commit each, guard + evidence per item)
1. **Cross-dock E2E** — `e2e/wms/crossdock.spec.ts`: inbound line matched → staged → dispatched without a storage bin, asserting no putaway task is generated and the outbound demand is satisfied.
2. **Returns lifecycle depth** — confirm RMA → receive → QC → disposition each go through `wms_transition_return`/`wms_transition_qc` and emit; add the owner-side read path for held stock where missing.
3. **Central label print queue** — promote `wmsLabels.ts` into a queue-backed seam: persisted job, retry with backoff, failure surfaced in the operator UI and in the exceptions inbox; guard that no WMS screen calls `PrintService` directly.
4. **Concurrency on bins/LPNs** — extend optimistic `row_version` checks to LPN and bin mutations so two operators on the same plate get the typed conflict toast rather than a lost update.
5. **Exception SLA escalation** — scheduled sweep: `due_by` breach raises severity, notifies the supervisor queue, emits `warehouse.exception.escalated` (new catalog entry both sides).
6. **Inventory reconciliation guard** — assert every WMS quantity-moving RPC writes through the canonical Inventory ledger, no WMS-only stock drift.

## Execution rules (carried forward)
- Never write `state`/`status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Replace legacy paths in the same change; delete dead modules instead of layering.
- A phase is green only when the full `wms-*` guard suite plus typecheck pass, and this file records the actual output as evidence.
