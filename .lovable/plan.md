# Warehouse plan — Round 6 verification + resume

**Active phase → Phase 3.9 (offline idempotency unification), then Phase 4 (UX & error-proofing).**
Phase 3.8 was declared complete but is not wired into the app. Fix that before any Phase 4 work.

---

## Phase 0 · Independent verification of the previous engineer's claims

Every claim re-checked directly against the codebase this round.

| Claim in ledger | Evidence gathered | Verdict |
|---|---|---|
| Guard suite 30 files / 113 tests green | `bunx vitest run src/test/architecture/wms-` → 30 files / 113 tests passed | Confirmed |
| Phase 3.7 scan-out enforcement + cancellation cascade | `wms-load-verification-enforced.test.ts` exists (4 tests) and pins `WMS_SCAN_SHORTAGE`, wave-reopened topic, task cancel edge, carton unbind | Confirmed |
| Phase 3.7 RPC grants audit | `wms-rpc-grants.test.ts` present and green | Confirmed |
| Phase 3.7 E2E dispatch scan-out + cancel spec | `e2e/wms/dispatch-scan-out-and-cancel.spec.ts` present | Confirmed (not executed against a live stack this round) |
| Phase 3.8 "offline mobile replay idempotency — COMPLETE" | `src/features/warehouse/scanning/useOfflineScanQueue.ts` exists, and the guard passes because it only greps the file. **No screen imports it.** Every mobile screen still calls the older `enqueue()` in `src/apps/warehouse-mobile/offlineQueue.ts` | **Not complete — duplicate, dead implementation** |
| Phase 4 (OutboxTimeline, typed exception triage, scan feedback, dashboards) | `OutboxTimeline` and `useScanFeedback` do not exist; `wms_exceptions` has no `resolution_kind` / `due_by` (the only `resolution_kind` in migrations is `qc_resolution_kind` on QC inspections) | Not started, as logged |

### The one material defect found

Two competing offline queues now exist:

- **Live path** — `src/apps/warehouse-mobile/offlineQueue.ts`, used by all eight mobile screens
  (`receive_goods_to_wms`, `complete_pick_task`, `record_count`, `seal_pack_carton`,
  `complete_pack_task`, `complete_putaway_task`, `load_carton_onto_manifest`,
  `close/dispatch_loading_manifest`, QC accept/reject/cancel). It persists `{rpc, args}` with an
  autoincrement key and **no client scan id**.
- **Dead path** — `useOfflineScanQueue.ts` (Phase 3.8), with the `client_scan_id` ledger,
  advisory-lock dedup and wrapper RPCs. Zero call sites.

The live queue's header comment asserts replay is safe because "all WMS RPCs carry natural
idempotency keys". That is false for the quantity-mutating calls: `receive_goods_to_wms`,
`complete_pick_task` and `record_count` derive their outbox key from the row they *create*, so a
replayed drain writes a second row and a second stock movement. A driver who loses signal mid-scan
can silently double-receive or double-pick. This is the highest-severity open item in the WMS and
it is exactly the "build new on top of defective architecture" failure mode the brief forbids —
so Phase 3.8 is reopened as Phase 3.9 with unification, not addition, as the goal.

---

## Phase 3.9 · Unify offline replay onto one idempotent queue

**Objective.** One offline queue, one retry policy, one dedup ledger, covering *every*
inventory-affecting mobile RPC — not just the two the previous round wrapped.

1. **Migration — generalise the scan-receipt ledger.**
   - Keep `wms_client_scan_receipts` and its `UNIQUE (device_id, client_scan_id)`.
   - Add a generic guarded dispatcher `wms_replay_guarded_call(p_rpc text, p_args jsonb,
     p_client_scan_id uuid, p_device_id text)` that takes the existing advisory lock, returns the
     stored result on replay, and otherwise executes the whitelisted target RPC and records the
     receipt. Whitelist is an explicit `CASE` over the sanctioned mobile RPCs — never `EXECUTE` of
     arbitrary text.
   - Fold the two Phase 3.8 wrappers (`wms_capture_receiving_line`, `wms_complete_pick_scan`) into
     this dispatcher so there is a single replay chokepoint; keep the old names as thin
     compatibility shims only if the E2E spec depends on them, otherwise drop them.
   - `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated, service_role`.

2. **Client — merge the queues.**
   - Extend `src/apps/warehouse-mobile/offlineQueue.ts` (the live one) to stamp
     `client_scan_id = crypto.randomUUID()` and the stable `wms_client_device_id` on every
     enqueue, route through the guarded dispatcher, and treat `replayed: true` as success.
   - Bump the IndexedDB schema to keyPath `client_scan_id`, with a v1→v2 upgrade that carries over
     any rows already queued on a driver's phone.
   - Delete `src/features/warehouse/scanning/useOfflineScanQueue.ts`. No parallel implementation
     survives this phase.

3. **Guards.**
   - Rewrite `wms-client-scan-id-unique.test.ts` to assert the ledger *and* that
     `src/apps/warehouse-mobile/offlineQueue.ts` is the module stamping the id.
   - New guard: every `enqueue("<rpc>")` literal in `src/pages/warehouse-mobile/**` appears in the
     dispatcher whitelist — a new mobile RPC cannot ship without a replay decision.
   - New guard: no module outside `offlineQueue.ts` defines an IndexedDB store for WMS scans.

4. **E2E.** Repoint `e2e/wms/offline-replay.spec.ts` at the dispatcher and add a second scenario
   covering `complete_pick_task` and `record_count`: triple-fire, assert one task completion, one
   stock movement, one outbox row.

**Exit criteria.** Guard suite green with the new guards; `useOfflineScanQueue.ts` deleted; every
mobile screen unchanged at the call site but idempotent underneath.

---

## Phase 4 · UX & error-proofing (unchanged in intent, sequenced)

1. **`<OutboxTimeline aggregateId />`** — reads `business_event_outbox` filtered by aggregate,
   renders ordered event chips (topic, actor, elapsed). One component, six call sites: LPN, wave,
   manifest, QC inspection, count session, receiving session. Build this first — §2 and §6 consume it.
2. **Typed exception triage.**
   - Migration: `wms_exception_resolution_kind` enum (`short_scan`, `damaged`, `wrong_bin`,
     `wrong_lp`, `legacy_short_dispatch`, `other`) on `wms_exceptions`, plus `due_by timestamptz`
     defaulted from the exception kind's SLA.
   - `wms_resolve_exception` requires a `resolution_kind`; `ExceptionsInbox` groups by SLA breach
     (`due_by < now()`), filters by kind, and shows the aggregate's `OutboxTimeline` inline.
3. **Contention toast.** `useWmsRealtimeSync` raises a toast when a task the current user is
   claiming flips to another `claimed_by` — the multi-operator race the brief calls out.
4. **`useScanFeedback()`** — one hook for success/error audio (Web Audio), haptics
   (`navigator.vibrate`), and a full-screen colour flash. Adopted across Receive, Putaway, Pick,
   Pack, Load, Count, QC. (Verified: no per-screen `beep()` helpers exist today, so this is pure
   addition, not a cleanup.)
5. **Two-context realtime Playwright smoke.** Driver A completes a task; Driver B's labour queue
   loses it within one realtime tick.
6. **Role-based dashboards**, all fed by the `business_event_outbox` subscription, no per-table polling:
   - Inbound: appointments, receiving sessions, discrepancies, cross-dock opportunities.
   - Outbound: waves by state, pack-station load, manifests awaiting dispatch, short-scan exceptions.
   - Supervisor: labour queue with SLA breach, unassigned work, assigned productivity.
7. **De-scaffold audit.** Sweep `e2e/wms/**` for `test.skip`, `TODO`, and empty bodies; implement or delete.

---

## Phase 5 · Newly identified gaps (added this round)

1. **Replay safety is a whole-module property, not a mobile one.** Desktop pages call the same
   quantity-mutating RPCs without a scan id. After Phase 3.9, audit desktop LoadingBay, PickList,
   PackStation and CountSession for double-submit exposure (double-click, retried mutation) and
   route them through the same dispatcher.
2. **Trailer no-show → labour reclaim.** Still deferred. Needs
   `wms_loading_manifests.trailer_visit_id` (or a join through `wms_dock_appointments`) so a
   no-show cancels open load/pick tasks through the same cascade a manual manifest cancel uses.
3. **Guard quality.** Several `wms-*` guards assert on file *contents* by grep. That is what let a
   dead module pass as shipped. Add a `wms-no-orphan-modules.test.ts` that fails when a file under
   `src/features/warehouse/**` has no importer outside tests.
4. **3PL billing event coverage.** Billing derives from activity events; confirm receipts, storage
   days, picks and shipments each emit a billable topic before the billing board is trusted.

---

## Operating rules (unchanged)

- Never write `state` / `status` directly to a WMS aggregate — always a `wms_transition_*` RPC.
- Every sanctioned RPC emits onto `business_event_outbox` via trigger, never in-body.
- Run the entire `wms-*` guard suite before declaring a phase green.
- Replace legacy paths in the same change — never build on defective architecture.
- Update this file with evidence (query output, test output), not assertions.
- A feature is not shipped until a real call site consumes it.
