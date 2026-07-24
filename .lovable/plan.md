# Enterprise Legal Orders (Garnishments) — Execution Plan

Multi-phase hardening of the Legal Orders subsystem to enterprise-grade
quality (SAP HCM / Oracle HCM / Workday / D365 F&O / Odoo parity).

## Phase 1 — Recipient master data ✅
- Tables `legal_recipient_types`, `legal_recipients`, dedupe index,
  `legal_orders_records.recipient_id` FK + backfill, extended
  `public.legal_orders` view, `legal_recipient_merge` RPC, client
  seam, ADR-0093.

## Phase 2 — Lifecycle & engine seals ✅
- `_legal_order_fsm_guard` trigger + `_legal_order_publish_status_event`
  trigger + architecture test `legal-orders-phase2-seams`.
- (Phase 5 later fixed a schema mismatch in the publisher that had been
  silently swallowed — see below.)

## Phase 3 — Recipient financial continuity ✅
- View `legal_recipient_outstanding`, RPC `legal_recipient_statement`,
  hooks, `/hr/payroll/legal-orders/recipients` workspace tab, test.

## Phase 4 — Operator workspace ✅
- `LegalOrdersWorkspace` shell with four nested tabs, action-inbox
  Tasks page, legacy redirect, test `legal-orders-phase4-workspace`.

## Phase 5 — Cross-domain integration & guardrails ✅

Fully implemented and verified (2026-07-24).

Landed:
- **Publisher fix.** `_legal_order_publish_status_event` rewritten to
  use the real outbox schema (`org_id`, `event_type`, `source_doc_type`,
  `source_doc_id`, `payload`, `status`, `idempotency_key`). Previous
  version referenced `topic`/`aggregate_id`/`produced_by` and swallowed
  the exception, so no lifecycle events ever reached the outbox.
  Idempotency key = `legal_order.status_changed:<id>:<changed_at>:<from>><to>`.
- **Subscriber-scoped dispatch log.** New
  `legal_order_subscriber_dispatch_log(source_event_id, subscriber, …)`
  primary-keyed by both columns so multiple domains can independently
  consume the same source event.
- **Finance drift subscriber.** RPC
  `legal_order_check_finance_drift(event_id, org_id, business_id, topic, payload)`
  recomputes accrued (from `garnishment_ledger`) and paid (from
  `legal_order_remittance_lines`) per recipient, compares to the
  `legal_recipient_outstanding` view, and opens
  `finance_integrity_issues` rows on `paid > accrued` (severity
  `error`, code `legal_order.recipient_over_remit`) or drift above
  0.01 (`warning`, code `legal_order.recipient_rollup_drift`).
- **ESS employee subscriber.** RPC `legal_order_notify_employee`
  resolves the affected employee's linked `auth.uid()` and calls
  `create_notification` under `payroll` category with a deep link to
  `/me/legal-orders`. Fires on `status_changed → active/suspended/
  satisfied/released` and on every `payment_posted`.
- **Subscription registry rows.** Four rows in
  `business_event_subscriptions` (finance + ess against status_changed
  and payment_posted) — this is the authoritative subscription table
  even though the dispatcher's routing is edge-function code.
- **Dispatcher routing.** `supabase/functions/outbox-dispatcher/index.ts`
  now handles the new `legal_order.status_changed` topic and calls the
  shared `fanoutFinanceAndEss` helper from both handlers.
- **ESS surface.** `src/pages/me/MyLegalOrders.tsx` now shows
  `recipient_name` (falling back to authority_name) and per-order
  running balance (`total_accrued - total_paid`) sourced from the
  existing `legal_orders` view — no new RPC.
- **Writer-guard architecture test.**
  `src/test/architecture/legal-orders-phase5-writer-guard.test.ts`
  parses every `supabase/migrations/*.sql`, extracts function bodies by
  dollar-quoted tag, and fails the build if any
  `UPDATE ... legal_orders_records SET status = ...` lives outside the
  five sanctioned functions (`garnishment_transition_impl`,
  `garnishment_transition`, `apply_system_garnishment_transition`,
  `apply_garnishment_payment_to_order`, `garnishment_auto_expire`).
  Also pins the presence of the new migration objects, dispatcher
  routing, and ADR-0094.
- **ADR-0094** — `docs/adr/0094-legal-order-event-integration.md`
  documents the emitter contract, subscriber responsibilities, payload
  shape for both topics, and idempotency model.

Verified:
- `bunx vitest run src/test/architecture/legal-orders-phase*.test.ts`
  → 15/15 tests, 4 files, all green.
- Migration applied cleanly; only pre-existing project-wide linter
  noise (security-definer views from other modules) reported.

## Phase 6 — Localization & jurisdiction packs (NEXT)

Currently the next active phase.

### Preconditions the next agent must verify before starting

1. Read `.lovable/plan.md` end-to-end and confirm Phases 1–5 are marked
   complete.
2. Run `bunx vitest run src/test/architecture/legal-orders-phase*.test.ts`
   — must show 15/15 green (4 files).
3. Confirm the DB objects added in Phase 5 exist:
   - table `public.legal_order_subscriber_dispatch_log`;
   - functions `public.legal_order_check_finance_drift`,
     `public.legal_order_notify_employee`;
   - four rows in `public.business_event_subscriptions` for
     `legal_order.status_changed` and `legal_order.payment_posted`.
4. Manually trigger a status transition in a dev org (e.g.
   `select garnishment_transition('<id>','activate',null,null)`);
   confirm a row appears in `business_event_outbox` with
   `event_type = 'legal_order.status_changed'`, and after the
   dispatcher tick a row appears in
   `legal_order_subscriber_dispatch_log` for both subscribers.
5. Fire a synthetic over-remittance in seed data; confirm one row
   opens in `finance_integrity_issues` with code
   `legal_order.recipient_over_remit` and `details.source_event_id`
   set — this is the "drift alert has fired at least once against
   seed data" gate called out in the earlier plan.
6. Smoke `/me/legal-orders` while impersonating an employee with a
   linked user — recipient name and running balance render.

### Phase 6 scope (only after preconditions pass)

1. **Country/jurisdiction pack schema.** Introduce
   `legal_order_jurisdiction_packs(country, region, effective_from,
   effective_to, rules jsonb)` with a `security_invoker` view resolving
   the currently-effective pack per org.
2. **Cross-country garnishment kinds.** Extend
   `garnishment_kind_defaults` seeds per pack (US federal + state,
   UK AEO/DEA, KE court, ZA emoluments, IN section 60, DE Pfändung,
   FR saisie, AU child support, CA family responsibility). One
   migration per country; each migration must include GRANTs and RLS.
3. **Priority + cap engine hook.** Extend `computeGarnishments` to
   consult the resolved pack for `priority_class`,
   `aggregate_cap_membership`, `protected_earnings_rule`. No behavior
   change for orgs without a pack (defaults preserved).
4. **Pack management UI.** New workspace tab
   `/hr/payroll/legal-orders/packs` (admin-only) listing active packs
   with a diff view against the seeded baseline.
5. **ADR-0095.** Document the pack contract, resolution order
   (`org override > country/region seed > global default`) and
   migration playbook.

### Guardrails to preserve while doing Phase 6

- Do not open a new status writer. All status changes still route
  through the FSM; the writer-guard test enforces this.
- Do not bypass `create_notification` for ESS pings.
- Do not add new outbox topics without a corresponding dispatcher
  handler entry — unknown topics DLQ hard by design.

## Next-agent handoff instructions

1. Read this plan end-to-end. Do not skip Phase 5's verification list
   above — it exists because Phase 2 shipped a broken publisher for a
   week that nobody caught until Phase 5.
2. Run the four architecture-test files in this subsystem
   (`legal-orders-phase*.test.ts`). If any fail, fix regressions
   before adding new work.
3. Manually trigger the smoke steps under "Preconditions" §4-§6
   above.
4. Only then start Phase 6 step 1. Ship each numbered step as its own
   migration + test + plan update before moving to the next.
5. After every phase step, append status to this file — never leave it
   stale.
