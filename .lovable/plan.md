# WMS plan — round 6 (verification & resume)

**Active phase → Phase 5 (newly identified gaps).** Phase 4 (UX & error-proofing) is complete.
Evidence for each item is recorded below; nothing is marked done on assertion alone.

---

## Status ledger

| Phase | Scope | Status |
|---|---|---|
| 0 | Independent verification of prior claims | Complete (see archived round-6 plan) |
| 3.7 | Scan-out enforcement + cancellation cascade | Complete (verified) |
| 3.9 | Unified offline replay idempotency | Complete |
| 4 §1 | `<OutboxTimeline />` + six call sites | Complete |
| 4 §2 | Typed exception triage (`resolution_kind`, `due_by`) | Complete |
| 4 §3 | Contention toast in `useWmsRealtimeSync` | Complete |
| 4 §4 | `useScanFeedback()` adopted across scan screens | Complete |
| 4 §5 | Two-context realtime Playwright smoke | Complete |
| 4 §6 | Role dashboards (inbound / outbound / supervisor) | Complete |
| 4 §7 | De-scaffold audit of `e2e/**` | Complete |
| 5 | Newly identified gaps | Not started |

---

## Phase 3.9 · Unified offline replay (complete)

- `wms_client_scan_receipts` + `UNIQUE (device_id, client_scan_id)`, advisory-locked lookup.
- `wms_replay_guarded_call` is the single server-side chokepoint; static `CASE` whitelist,
  `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated, service_role`.
- `src/apps/warehouse-mobile/offlineQueue.ts` stamps `client_scan_id` (`crypto.randomUUID()`) and
  `device_id` into a v2 IndexedDB `scans` store; every drain routes through the dispatcher.
- Dead duplicate `src/features/warehouse/scanning/useOfflineScanQueue.ts` deleted.
- Guard: `src/test/architecture/wms-client-scan-id-unique.test.ts` (whitelist parity, no second
  IndexedDB queue, no bare `supabase.rpc as any` in the queue).
- E2E: `e2e/wms/offline-replay.spec.ts` incl. non-whitelisted RPC rejection.

## Phase 4 · UX & error-proofing (complete)

1. **Event trail.** `src/features/warehouse/events/OutboxTimeline.tsx` +
   `ActivitySection.tsx` (`<ActivitySection />` inline, `<ActivityHistoryButton />` dialog).
   Six call sites: `LicensePlateView`, `PickList`, `LoadingBay`, `QCInspectionDetail`,
   `CountSession`, `ReceivingSessions`.
2. **Typed exception triage.** `wms_exception_resolution_kind` + SLA `due_by` on
   `wms_exceptions`; `wms_resolve_exception` requires `p_resolution_kind`; `ExceptionsInbox`
   blocks terminal transitions without a cause, groups on SLA breach, shows the timeline inline.
   `_wms_emit_outbox` repaired (correct columns, no swallowed exceptions).
3. **Contention toast** in `useWmsRealtimeSync` when a claimed task flips owner.
4. **`useScanFeedback()`** — audio / haptics / colour flash, wired via `MobileWarehouseLayout`
   and the offline queue.
5. **Two-context realtime smoke** — `e2e/wms/realtime-contention.spec.ts`: driver A claims and
   completes a seeded task; driver B's board retires it on the realtime tick, no refresh.
6. **Role dashboards** — `InboundDashboard`, `OutboundDashboard`, `SupervisorDashboard` under
   `src/pages/warehouse/`, shared tiles in `features/warehouse/dashboards/DashboardPrimitives.tsx`,
   routed at `/warehouse-app/dashboard/{inbound,outbound,supervisor}` and linked from
   `apps/warehouse/nav.ts`. All queries use realtime-invalidated key prefixes — zero
   `refetchInterval`. `wms_dock_appointments` added to `supabase_replicate`/`supabase_realtime`
   with `REPLICA IDENTITY FULL` so the inbound tower is event-driven.
7. **De-scaffold audit.** No `describe.skip` remains anywhere under `e2e/**`; the only skips left
   are env guards (`no injected supabase session`). `wms-phase14.test.ts` now enumerates the
   spec directories rather than a static table, so a new scaffolded-out spec cannot ship.

**Guards added this phase:** `wms-phase4-ux.test.ts` extended with §1 call-site coverage, an
"OutboxTimeline is the only reader of `business_event_outbox`" rule, and §6 dashboard
routing / realtime-key / business-scope assertions.

**Verification:** `bunx vitest run src/test/architecture/wms-` → 31 files green;
`bunx tsgo --noEmit -p tsconfig.app.json` → clean.

---

## Phase 5 · Newly identified gaps (next)

1. **Desktop replay safety.** Route LoadingBay, PickList, PackStation, CountSession
   quantity-mutating calls through `wms_replay_guarded_call` (double-click / retried mutation).
2. **Trailer no-show → labour reclaim.** Needs `wms_loading_manifests.trailer_visit_id` (or a
   join through `wms_dock_appointments`) so a no-show cancels open load/pick tasks via the same
   cascade as a manual manifest cancel.
3. **Guard quality.** Add `wms-no-orphan-modules.test.ts` — fail when a file under
   `src/features/warehouse/**` has no importer outside tests (this is what let a dead module pass
   as shipped in Phase 3.8).
4. **3PL billing event coverage.** Confirm receipts, storage days, picks and shipments each emit
   a billable topic before the billing board is trusted.
5. **Receiving E2E gap** — `e2e/wms/receive.spec.ts` still needs a
   `create_goods_receipt(p_po_id, p_warehouse_id)` seam (TODO 14a.2) to drive receipt from the UI.

---

## Operating rules (unchanged)

- Never write `state` / `status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Run the entire `wms-*` guard suite before declaring a phase green.
- Replace legacy paths in the same change — never build on defective architecture.
- Update this file with evidence (query output, test output), not assertions.
- A feature is not shipped until a real call site consumes it.
