
# Legal Orders on Payroll — Lifecycle Alignment

## What the investigation established (verified, not assumed)

An active `legal_orders_records` row exists (kind `child_support`, fixed 7,000, priority 10, org + employee + period all match the run). The `garnishment_transition` fix from the previous pass is in place — status is `active` at 10:47:14, the payroll run was created at 10:48:23, and the same employee has a payslip. Yet `payslip_lines` for that payslip contains **no `garnishment` row and no `garnishment_admin_fee` employer line**. Every other layer is architecturally in place already:

- `compute-payroll/index.ts` loads active orders (`legal_orders_records`, org + employee + period + status filters), resolves per-kind defaults and org policy via `garnishment_resolve_kinds` / `garnishment_resolve_policy`, applies always-first ordering, disposable calc, aggregate cap, floor, per-order `total_owed − total_accrued` cap, employer admin fees, and carry-forward shortfalls. It emits `deductionsDetail[garnishment_<id>]` + a `garnishment` payslip line + tracks `garnishmentsApplied` for stamping `total_accrued` / `total_paid` and rolling carry-forward.
- `post-payroll-gl` aggregates `garnishment` category lines per `garnishment_id`, requires the `garnishment_payable` account role, writes CR liability + `payroll_liabilities` row keyed by `garnishment_<uuid>` and linked to the order and payee.
- `post-garnishment-payment` FIFO-consumes open liabilities per order, posts JE + `payments` + allocations; `trg_apply_garnishment_payment_to_order` bumps `total_paid` / satisfies the order; a `legal_order.payment_posted` event is emitted onto `business_event_outbox` for finance/audit/analytics.
- Kind + policy sources come from the localization pack via resolver RPCs; the engine itself is country-agnostic.

The engine is architecturally complete. The failure is a **single functional gap plus a fragile edge in the pipeline**, not a missing subsystem.

## Root cause of the missing payslip line

Two problems compound on the pathway between an active order and a payslip line, and this plan fixes both. They must both hold; the first is why the current payslip is empty, the second is why the same thing would happen again to the next tenant:

1. **Silent-skip on the garnishments SELECT.** In `compute-payroll/index.ts` the `legal_orders_records` load (`const { data: garn } = await …`) discards the error. Any transient PostgREST error (rename cache after the Phase-7 `employee_garnishments → legal_orders_records` migration, RLS drift, missing grant, a bad column) makes `garn = null`, `garnishmentsByEmployee` empty, and the run finishes without a single log line. The garnishment kind/policy loads use `console.warn` and continue in the same way. The engine must fail loudly on any garnishment data-load error so a run cannot post silently under-deducted. The same fix pattern is already used elsewhere in the file for statutory rules.

2. **No re-compute trigger when an order is activated between draft and post.** Right now a draft payslip snapshots the world at compute time. Activating an order later has no effect on the existing draft — the user sees a stuck payslip and no signal that it needs recomputing. Every mature payroll engine (SuccessFactors, Workday, Odoo Hr Payroll) makes the payslip either **event-invalidated** or explicitly re-computed on approve/activate/suspend/resume of a garnishment that falls inside the run's window. The `legal_order.*` topic already exists on `business_event_outbox` (previous fix); nothing consumes it yet.

Both are enterprise-grade correctness issues, not cosmetic ones.

## Changes

### 1. Fail loudly on garnishment data-load errors (`supabase/functions/compute-payroll/index.ts`)

- Capture `error` on the three loads that currently discard it: `legal_orders_records` SELECT, `garnishment_carry_forward` SELECT, `garnishment_kind_defaults` fallback (already warned) and the two resolver RPCs — promote all five from `console.warn` / silent-null to a hard `throw new Error("garnishment_load_failed: …")` that aborts the run job. The job orchestrator already surfaces the error into `payroll_run_jobs` and the UI banner.
- Add an explicit `console.info("[compute-payroll] loaded N active legal orders for M employees")` after the load so future runs are traceable in the edge-function log.

### 2. Recompute-on-activation via the outbox (event-driven, single canonical path)

- New consumer edge function `payroll-react-to-legal-order` (server-side, no user JWT) invoked by a lightweight Postgres cron that drains `business_event_outbox` rows with `topic LIKE 'legal_order.%'` and `handler_scope='server'` (same pattern the inventory sagas already use). Handles topics `legal_order.activated`, `legal_order.suspended`, `legal_order.resumed`, `legal_order.released`, `legal_order.expired`, `legal_order.mark_satisfied`, `legal_order.terminate_unsatisfied`.
- For each event, find any `payroll_runs` row for the same `(organization_id, business_id, employee_id)` with `status IN ('draft','pending_approval')` and `pay_period_end >= order.start_date` and (order.end_date IS NULL OR pay_period_start <= order.end_date). Enqueue a recompute via existing `compute-payroll` (dry-run=false, same idempotency key format the retry path uses) and stamp `payroll_runs.needs_recompute_reason = 'legal_order_<action>_<order_id>'`.
- Approved/posted/paid/reversed runs are **never** silently mutated; the consumer instead writes a `payroll_readiness_findings` row of severity `warning` so finance sees "posted run X excludes order Y — file a correction run" — matching the maker-checker invariants already documented in `docs/audit/2026-06-06-hr-payroll-reaudit-v2.md`.
- No new deduction engine, no new event bus, no fork of `default_account_settings`. The existing `business_event_outbox` + `compute-payroll` + correction-run flow is reused.

### 3. One-shot recompute of the stuck payslip

- After change (1) deploys, invoke `compute-payroll` once for run `5b3ffca3-90db-41d1-866f-340e9eb1f43f` to regenerate its payslip lines (org 8e68…28b, business bf39…70d, employee 5449…c9ce, period 2026-05-01 → 2026-05-31). No migration needed — the RPC already replaces payslip_lines on recompute for draft runs. Expected result: a new `garnishment` line (`rule_code = garnishment_0dfb…70f`, label `child_support`, employee_amount ≈ 7,000), net pay dropping from 64,672.74 to 57,672.74, and (on subsequent post) a `payroll_liabilities` row keyed by that garnishment id.

### 4. Regression tests (architecture guards; the docs say the flow is complete — pin it)

- `src/test/architecture/compute-payroll-loud-garnishment-errors.test.ts` — grep-guard that fails if a future edit reintroduces a silent `const { data: garn } = await supabaseAdmin.from("legal_orders_records"…)` without an accompanying error throw.
- `src/test/architecture/legal-order-events-consumed.test.ts` — asserts that `payroll-react-to-legal-order` subscribes to every `legal_order.*` topic the transition RPC emits, so a new lifecycle action can't be added without wiring its consumer.
- `supabase/tests/legal_order_lifecycle_e2e_test.sql` — pgTAP: seed one active order → run `compute-payroll` mock (via a fixture RPC) → assert `payslip_lines` has the garnishment line → simulate `post-payroll-gl` → assert `payroll_liabilities` row exists keyed to the order → `post-garnishment-payment` → assert `total_paid` bumps and status transitions to `satisfied` when balance is cleared.

### 5. Documentation

- Extend `docs/audit/2026-06-06-hr-payroll-reaudit-v2.md` Shipped section with an entry `C-PAY-LEGAL-ORDERS` describing the loud-load + outbox-reactor + stuck-payslip recovery, and add the two invariants ("no silent garnishment loads" and "draft runs recompute on any `legal_order.*` event") to the invariants list.

## Out of scope (do not touch)

- The garnishment engine math (priority, cap, floor, carry-forward, employer admin fees).
- `default_account_settings` mapping validation (ADR-0022 already guards it at table tier).
- `garnishment_transition` state machine — the previous pass already brought it onto `publish_business_event`.
- Localization packs — they continue to supply kinds + policy via resolver RPCs; the engine stays country-agnostic.

## How to verify

1. Recompute run `5b3ffca3…` — confirm the child-support line appears, net drops by 7,000, `deductionsDetail.garnishment_0dfb…` = 7000.
2. Approve + post the run — confirm one `payroll_liabilities` row with `garnishment_id = 0dfb…`, `rule_code = garnishment_0dfb…`, `outstanding_amount = 7000`, `liability_account_id = garnishment_payable`.
3. Call `post-garnishment-payment` for the order — confirm JE posts, `total_paid` bumps to 7,000, `legal_order.payment_posted` outbox row lands.
4. In a fresh draft run, suspend the order via `garnishment_transition('suspend')` — confirm the reactor recomputes the draft and the garnishment line disappears.
5. All new tests pass; existing `payslip-classifier` / `payslip-explainer` tests still pass.
