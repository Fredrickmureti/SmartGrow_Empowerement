# Warehouse Exceptions Inbox — Architecture Audit & Execution Plan

## What a Warehouse Exceptions Inbox actually is

An exception is not a UI row. It is a **business event stating that physical reality diverged from system expectation**, raised by whichever subsystem detected the divergence, owned by a role, resolved by a corrective action that writes back to the originating domain, and closed with an auditable cause code. The inbox is the single convergence point where every warehouse subsystem publishes abnormality, and where supervisors run operational recovery.

Enterprise WMS platforms (EWM, Manhattan, Blue Yonder, D365 SCM) share five invariants:

1. **One canonical exception service.** Subsystems raise, they never keep private problem queues.
2. **Detection is automatic.** Exceptions come from the execution path, not from a human clicking "report issue".
3. **Lifecycle is a guarded FSM with ownership, SLA and escalation** — never a status column.
4. **Evidence is structured** (scan, photo, weight, sensor reading, document link), not free text.
5. **Every exception ends in a cause code** that feeds supplier / carrier / operator / product analytics.

## Audit findings (verified against the live database and source)

**The platform has a correct skeleton and almost no body.**

What exists and is sound:
- `wms_exceptions` with `organization_id / business_id / branch_id / warehouse_id`, `kind`, `state`, `severity`, polymorphic `aggregate_type` + `aggregate_id`, `task_id`, `lpn_id`, `details jsonb`, `raised_by`, `assigned_to`, `resolved_by`, `resolution`, `resolution_kind`, `due_by`, `row_version`.
- `wms_raise_exception` / `wms_resolve_exception` as the only sanctioned writers, with optimistic locking and a terminal-state cause-code requirement.
- Server-side SLA floor: `_wms_exception_sla_minutes(kind, severity)` stamps `due_by`.
- Table is in the `supabase_realtime` publication; `ExceptionsInbox.tsx` renders an SLA countdown and an FSM triage dialog.
- Outbox topics exist: `warehouse.exception.acknowledged | investigating | escalated | wont_fix`.

What is missing — the material gaps:

1. **Detection coverage is ~5%.** Only 5 database functions call `wms_raise_exception`: `_wms_crossdock_auto_break`, `wms_crossdock_break`, `wms_crossdock_sweep_expired`, `wms_post_return_dispositions`, `complete_replenish_task`. Verified as **not** raising: `wms_flag_receiving_variances`, `wms_capture_receiving_line`, `wms_post_receiving_session`, `reject_qc_inspection`, `record_qc_check`, `post_count_session`, `approve_count_variance`, `wms_task_reap_expired`, `wms_transition_task`, `wms_lpn_move`, `wms_transition_lpn`, `wms_operator_clock`, `wms_disposition_return_line`, `wms_dispute_billable_activity`. Receiving, QC, picking, counting, labour, LPN handling and dock/yard all detect their own problems and then drop them. The table currently holds **0 rows** — the inbox is empty because nothing feeds it, not because operations are clean.
2. **The kind taxonomy is a stub.** 11 values, mostly outbound-flavoured (`short_pick`, `unknown_scan`, `invalid_bin`, `stale_task`, `billing_unpriced`, `other`). No inbound over/under-receipt, wrong ASN, wrong supplier, expiry, serial duplication, dock no-show, trailer overstay, seal mismatch, weight mismatch, device offline, integration failure.
3. **No lifecycle history.** No `wms_exception_events` table. `state`, `resolved_at` and `row_version` are overwritten in place — there is no acknowledged-at / assigned-at / investigation-started trail, so MTTA and MTTR cannot be computed and no audit reconstruction is possible.
4. **No evidence model.** `details jsonb` only. No table for scans, photos, weights, sensor readings, inspection reports, or links to related business documents (GRN, PO, invoice, count session).
5. **Assignment is dead metadata.** `assigned_to` exists but no RPC sets it and no UI exposes it. Exceptions are anonymous; no role routing (receiving lead, inventory controller, QC inspector, maintenance, finance, procurement).
6. **No escalation engine.** `due_by` is stamped and rendered, but nothing sweeps overdue rows. `escalated` is a state a human can pick manually. SLA breach has no consequence.
7. **Notifications are disconnected.** A full notification stack exists (`notifications`, `notification_preferences`, `notification_delivery_log`, `notification_digest_queue`) and is never wired to exception topics. The exception waits silently.
8. **Hardware cannot raise exceptions.** `hardware_exec_log`, `hardware_command_queue`, `device_assignments`, `user_devices` exist; no failure path converges on the exceptions service.
9. **No analytics and no command centre.** The inbox is a flat 200-row table filtered by warehouse and state. No severity/ageing triage, no supplier / carrier / operator / product recurrence, no MTTR, no financial impact, no cross-warehouse view.
10. **Emerging duplication.** `bill_match_exceptions`, `finance_integrity_issues`, `payroll_run_issues` are separate problem queues. Warehouse must not add more; anything warehouse-detected belongs in the canonical service.

## Verdict

**Architecturally sound foundation, operationally non-functional.**

The write model (single-writer RPCs, optimistic locking, polymorphic aggregate reference, org/business/branch/warehouse scoping, outbox emission, realtime) is the right one and should be preserved, not replaced. The failure is that it was never adopted: detection was never pushed into the execution path, and the lifecycle lacks history, evidence, ownership and escalation.

Verdict: **extend the existing platform; do not rebuild it.** No new exception tables outside `wms_exceptions` and its satellites; no per-subsystem problem queues.

## Execution plan

### Phase 1 — Canonical domain (database)
- Extend `wms_exception_kind` to the full warehouse taxonomy across inbound, inventory, storage, picking, packing, shipping, dock, yard, cross-dock, counting, labour, QC, returns, equipment and integration.
- Add `wms_exception_class` (operational, quality, safety, compliance, financial, customer_impact, informational) alongside numeric severity; SLA becomes a function of `(kind, class, severity)`.
- Add `wms_exception_events` — append-only lifecycle log (from_state, to_state, actor, role, reason, payload, at). Written only by the transition RPCs.
- Add `wms_exception_evidence` — typed evidence rows (scan, photo, weight, dimension, temperature, sensor reading, document reference, external doc) with storage path or structured value.
- Add `wms_exception_links` — related business documents (GRN, PO, ASN, count session, QC inspection, manifest, invoice, task, LPN) with typed relation.
- Add `wms_exception_policies` — declarative routing: kind/class → severity, SLA minutes, owner role, escalation ladder.
- All new tables: GRANTs, RLS scoped to the caller's organisation/business, `updated_at` triggers, realtime where the UI needs it.

### Phase 2 — Detection at source
Wire `wms_raise_exception` into every execution path that already detects divergence, using deterministic idempotency keys so replays do not duplicate:
- Receiving: variance flagging, line capture, session post, ASN/supplier mismatch, damaged goods.
- QC: check failure, rejection, quarantine.
- Inventory & LPN: negative/phantom stock, expiry, duplicate serial, capacity exceeded, invalid bin, unexpected movement.
- Picking / packing / shipping: short pick, wrong item or batch, SLA breach, weight mismatch, missing carton, blocked dispatch.
- Counting: variance beyond threshold, repeated discrepancy.
- Labour: abandoned task via `wms_task_reap_expired`, missed target.
- Dock / yard / cross-dock: no-show, congestion, overstay, seal mismatch, demand loss, routing conflict.
- Hardware: device offline / command failure from the hardware execution log.

### Phase 3 — Lifecycle, ownership, escalation
- `wms_assign_exception` (owner or role, with reassignment history) and `wms_acknowledge_exception`.
- Extend `wms_resolve_exception` to write `wms_exception_events` on every transition and to enforce the policy-driven required evidence and cause code on terminal states.
- `wms_escalate_overdue_exceptions` sweep (pg_cron) applying the escalation ladder to breached SLAs.
- Emit the full topic set to `business_event_outbox` — created, assigned, acknowledged, escalated, resolved, closed.

### Phase 4 — Notification bridge
Consume exception outbox topics into the existing notification stack — in-app, digest, email/SMS where configured — driven by policy and severity, honouring `notification_preferences`. No new notification infrastructure.

### Phase 5 — Command centre UI
Rebuild `ExceptionsInbox.tsx` as an operational workspace:
- Cross-warehouse triage board: severity × ageing, SLA countdowns, breach highlighting, live realtime updates.
- Row detail: lifecycle timeline, evidence gallery, linked documents with one-click navigation, assignment and escalation controls, corrective-action panel driving the domain RPC that actually fixes the problem (cycle count request, inventory adjustment, QC re-inspection, task re-issue).
- Saved views and role-scoped queues (receiving lead, inventory controller, QC, maintenance).

### Phase 6 — Analytics
Views and a dashboard for MTTA/MTTR, recurrence by kind, supplier, carrier, operator, product and location, SLA compliance, financial and inventory impact, root-cause trend, warehouse heatmap.

### Phase 7 — Guardrails
- Architecture tests: no direct `insert`/`update` on `wms_exceptions` outside the sanctioned RPCs; no new per-subsystem problem tables in the warehouse domain; every `wms_exception_kind` value has a policy row.
- ADR update to 0101 recording exceptions as a shared enterprise service.

## Technical notes

- Existing contracts preserved: `wms_raise_exception` / `wms_resolve_exception` remain the only writers; `row_version` optimistic locking retained; all enum changes are additive (`ALTER TYPE ... ADD VALUE`), so rollback is dropping the new satellites.
- Detection calls live inside the existing `SECURITY DEFINER` domain functions, so they inherit the caller's scope and run in the same transaction as the divergence they describe.
- Idempotency keys follow the ADR 0101 convention `wms.exception:{aggregate}:{id}:{kind}`.
- Evidence binaries go to storage with a private bucket and signed access; the table stores paths, never blobs.
- Frontend reads stay on the generated Supabase client with realtime subscriptions inside `useEffect` and channel cleanup.

## Scope

This is delivered in phases. Each phase is independently shippable; Phases 1–3 constitute the architectural correction, Phases 4–6 the operational surface.

---

## Closure record — 2026-08-04

All six phases delivered. Status: CLOSED.

- Phase 1 — Canonical domain: exception class/owner-role/event/evidence/link enums, 44 new kinds, extended `wms_exceptions`, satellites (`wms_exception_events`, `_evidence`, `_links`, `_policies`), policies seeded for all 57 kinds, idempotent policy-driven `wms_raise_exception`.
- Phase 2 — Detection at source: triggers on receiving lines, QC inspections, count lines, tasks, license plates, return lines, stock quants and dock appointments, plus `wms_detect_operational_exceptions()` for yard overstay, SLA breach, expiry and device staleness.
- Phase 3 — Lifecycle: `wms_assign_exception`, `wms_acknowledge_exception`, `wms_escalate_overdue_exceptions`; pg_cron detection every 10 min, escalation every 5 min.
- Phase 4 — Notification bridge: `wms_exception_subscriptions`, `_wms_notify_exception` fan-out to owners and subscribers plus `warehouse.exception.*` on `business_event_outbox`. Verified end to end after fixing an integer `notifications.priority` cast and an invalid `event_source_domain` value ('wms' -> 'warehouse') that were silently suppressing delivery.
- Phase 5 — Command centre UI: rebuilt `ExceptionsInbox` with health tiles, class/owner/severity/scope/overdue filters and search; new `ExceptionDetailSheet` exposing lifecycle history, evidence capture, linked records, the governing policy, assignment/acknowledgement and the evidence-gated close-out.
- Phase 6 — Analytics: `ExceptionAnalytics` reports 90-day recurrence by kind, root-cause mix, class exposure, MTTR, SLA compliance, ageing and financial exposure.

No open items.
