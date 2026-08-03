# Cross-Dock — verification verdict and remaining phases

## 1. Verification of the previous engineer's claims

Checked directly against the database and the code, not the notes.

**Genuinely done (Phases 1–3):**
- FSM is real. `wms_crossdock_state` lifecycle columns all exist on `wms_crossdock_opportunities` (`state`, `demand_type`, `demand_doc_id`, `demand_line_id`, `score`, `rule_id`, `qualified_at`, `reject_reason`, `break_reason`, `expires_at`, `staging_location_id`, `outbound_dock_id`, `appointment_id`, `assigned_user_id`, `load_task_id`, `manifest_id`, `savings_estimate`, `row_version`).
- `wms_crossdock_rules` and append-only `wms_crossdock_history` exist, with immutability and history triggers plus a legacy `status` mirror trigger, so old consumers still work.
- Qualification engine `_wms_crossdock_detect` plus `_wms_crossdock_resolve_rule`, `_wms_crossdock_staging_location`, `_wms_crossdock_guard` exist.
- Orchestration RPCs all exist: `wms_crossdock_approve/_reject/_start_staging/_confirm_staged/_mark_loaded/_complete/_break`, each taking `p_row_version`.
- `wms_crossdock_sweep_expired` exists and is scheduled hourly on pg_cron.
- Client wrapper `src/features/warehouse/crossdock/useCrossdock.ts` exists; `CrossdockBoard` is lane-based and calls no RPC directly; guards in `wms-phase12.test.ts` cover RPC-only writes and the wrapper's FSM coverage. ADR 0107 is written.

**Claims that do not hold / work still open:**
- **Phase 4 (exception handling) was never started.** No trigger, saga subscriber or subscription breaks an opportunity when the sales order is cancelled, the receipt is short, QC later fails, the appointment is cancelled or the dock is pulled. `wms_crossdock_break` exists but nothing calls it automatically.
- **Requalification sweep missing.** Only expiry is swept. Scores are never recomputed and vanished demand is never detected.
- **Phase 5 is half done.** The board still polls every 15 s (`refetchInterval: 15_000`) — no Realtime; `wms_crossdock_opportunities` is not in the `supabase_realtime` publication. The query selects raw IDs only, so the supervisor sees UUIDs instead of product, customer, order number, dock and operator. There is no rules editor and no bulk approve.
- **Phase 6 not started.** No `wms_crossdock_metrics_view`, no KPI surface, no routing/stage label request through the document platform (zero cross-dock references in `src/services/printing`).
- **Detection still narrower than planned.** Sales orders and transfers only — replenishment and production demand are not detected.
- **Phase 7 partial.** `crossdock-orchestration.test.ts` does not exist; topic/state parity and "no direct update" checks beyond the existing two are missing.

Verdict: the engine core is real and correctly bounded (cross-dock writes no stock). What is missing is everything that makes it *react* and everything that makes it *readable*.

## 2. Remaining work

**Phase 4 — Exception handling (highest value).**
Break or re-qualify opportunities automatically when reality changes:
- DB triggers: sales order / transfer line cancelled or quantity reduced → `wms_crossdock_break` with a typed reason; QC inspection failing after detection → break; GRN line quantity revised below matched quantity → break or reduce.
- Yard/dock side: appointment cancelled or dock deactivated while an opportunity holds it → break and clear `outbound_dock_id`.
- Every automatic break raises a `wms_exceptions` row addressed to the warehouse supervisor and emits `warehouse.crossdock.broken`.
- Add `wms_crossdock_requalify_sweep()` (pg_cron, every 15 min): re-score open rows, expire past cut-off, break rows whose demand no longer exists.

**Phase 5b — Decision centre completion.**
- Add the table to the `supabase_realtime` publication; subscribe in `useCrossdock` and drop the poll.
- Enrich the opportunity read with product name/SKU, demand document number, customer name, dock code, staging location code and assignee name (a `wms_crossdock_board_view` keeps the client join-free).
- Countdown chip driven by `expires_at`, urgency sort, blocked/rejected reason surfaced inline, bulk approve on the "Awaiting decision" lane.
- Rules editor (list/create/edit/deactivate `wms_crossdock_rules`) behind the same aggregate wrapper.

**Phase 6 — Demand coverage, documents, KPIs.**
- Extend `_wms_crossdock_detect` to replenishment demand (`wms_replen_rules` driven) and production demand where a work-order table exists.
- Cross-dock routing/stage label requested from the document platform and dispatched through the existing print router bound to the dock's label printer — no local generation.
- `wms_crossdock_metrics_view` + KPI strip: success rate, storage days avoided, touches avoided, average dwell, fulfilment acceleration, split by customer / supplier / warehouse / operator.

**Phase 7 — Guards and ADR update.**
- New `crossdock-orchestration.test.ts`: every `wms_crossdock_state` value has a registered topic; the board contains no `supabase.rpc`; no direct `.update()` on the opportunities table anywhere; the exception subscribers stay wired.
- Amend ADR 0107 with the exception matrix, the requalification sweep and the metrics view.

## 3. Technical notes

All state writes stay `SECURITY DEFINER` RPC-only with `p_row_version` optimistic concurrency (ADR 0101). Events keep going to `business_event_outbox` with `wms.crossdock:<id>:<transition>` idempotency keys — never direct to Realtime. Automatic breaks use `EXCEPTION WHEN OTHERS THEN RAISE WARNING` inside their triggers so a cross-dock failure never blocks a sales order, QC or GRN transaction. Stock truth stays in Inventory; cross-dock continues to decide and direct, never to post movements.
