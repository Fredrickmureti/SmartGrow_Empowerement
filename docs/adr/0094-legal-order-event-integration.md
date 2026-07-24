# ADR-0094 — Legal Order Event Integration Contract (Phase 5)

## Status

Accepted — 2026-07-24.

## Context

Phases 1-4 delivered the recipient master-data aggregate, the FSM seal,
the recipient financial-continuity layer, and the operator workspace.
The subsystem now has two authoritative event sources:

- `_legal_order_publish_status_event` — AFTER UPDATE OF status on
  `legal_orders_records`, emitted from any transition function that
  advances the FSM (`garnishment_transition_impl`,
  `apply_system_garnishment_transition`,
  `apply_garnishment_payment_to_order`).
- `post-garnishment-payment` edge function — emits
  `legal_order.payment_posted` once a payroll remittance is settled.

Prior to Phase 5, `_legal_order_publish_status_event` referenced columns
that do not exist on `business_event_outbox` (`topic`, `aggregate_id`,
`produced_by`) and swallowed the failure with a bare
`EXCEPTION WHEN undefined_column`. As a result no lifecycle events ever
reached the outbox, and finance/ESS could not subscribe to them.

## Decision

1. **Fix the emitter.** `_legal_order_publish_status_event` now writes
   the outbox row using the actual schema (`org_id`, `event_type`,
   `source_doc_type`, `source_doc_id`, `payload`, `status`,
   `idempotency_key`). The idempotency key is
   `legal_order.status_changed:<order_id>:<changed_at>:<from>><to>` so
   the same accepted transition cannot be double-published.

2. **Two subscribers per event topic.** Both are registered in
   `business_event_subscriptions` and both are idempotent per
   `(source_event_id, subscriber)` via
   `legal_order_subscriber_dispatch_log`.

   | Topic | Subscriber | Domain | Handler function |
   | --- | --- | --- | --- |
   | `legal_order.status_changed` | `finance.drift_checker` | finance | `legal_order_check_finance_drift` |
   | `legal_order.status_changed` | `ess.employee_notifier` | ess | `legal_order_notify_employee` |
   | `legal_order.payment_posted` | `finance.drift_checker` | finance | `legal_order_check_finance_drift` |
   | `legal_order.payment_posted` | `ess.employee_notifier` | ess | `legal_order_notify_employee` |

3. **Finance drift responsibility.** For the recipient carried by (or
   inferred from) the event, `legal_order_check_finance_drift` recomputes
   accrued (`garnishment_ledger`) and paid
   (`legal_order_remittance_lines`) totals from source-of-truth tables
   and compares them to the aggregate rollup exposed by
   `legal_recipient_outstanding`. On divergence beyond 0.01 or on
   over-remittance (`paid > accrued`) it opens a
   `finance_integrity_issues` row with the diagnostic payload embedded in
   `details.source_event_id`.

4. **ESS responsibility.** `legal_order_notify_employee` notifies the
   affected employee's linked auth user via `create_notification` under
   the `payroll` category with a deep link to `/me/legal-orders`.
   Notifications are emitted only for lifecycle transitions to
   `active`, `suspended`, `satisfied`, or `released` and for every
   posted payment.

5. **Payload shape (contract).**

   ```jsonc
   // legal_order.status_changed
   {
     "legal_order_id":  "<uuid>",
     "garnishment_id":  "<uuid>",   // legacy alias
     "organization_id": "<uuid>",
     "business_id":     "<uuid|null>",
     "employee_id":     "<uuid>",
     "recipient_id":    "<uuid|null>",
     "from_status":     "<enum>",
     "to_status":       "<enum>",
     "status_reason":   "<text|null>",
     "changed_at":      "<iso>",
     "changed_by":      "<uuid|null>"
   }

   // legal_order.payment_posted
   {
     "legal_order_id":  "<uuid>",
     "payment_id":      "<uuid>",
     "amount":          "<numeric>",
     "reference_number":"<text|null>",
     "payment_date":    "<date>",
     "journal_entry_id":"<uuid|null>",
     "actor_user_id":   "<uuid|null>"
   }
   ```

6. **Writer guard.** Any SQL migration that runs
   `UPDATE ... legal_orders_records SET status = ...` outside the four
   sanctioned SECURITY DEFINER functions
   (`garnishment_transition_impl`, `garnishment_transition`,
   `apply_system_garnishment_transition`,
   `apply_garnishment_payment_to_order`) is a bypass of the FSM. The
   database trigger `_legal_order_fsm_guard` (ADR-0093 Phase 2) rejects
   the write at runtime; the architecture test
   `legal-orders-phase5-writer-guard` fails the build before the
   migration is applied. Both must remain in place.

## Consequences

- Finance and ESS domains subscribe by contract, not by cross-domain
  imports. Adding a new subscriber is a `business_event_subscriptions`
  row plus a handler routed in `supabase/functions/outbox-dispatcher`.
- Drift is caught synchronously with the event that could have produced
  it. `finance_integrity_issues` is the single tray operators watch.
- ESS employees see lifecycle and payment activity in-app without any
  ESS module reading the payroll writer tables directly.

## Addendum (Phase 8) — Audit projection contract

The write side of a legal order emits events through the outbox (above). The
**read side** of "what happened to this order" is served by a single
canonical projection: `public.v_legal_order_audit_timeline`. This addendum
extends the ADR-0094 contract to cover that projection so downstream
consumers (Audit tab, statutory reports, external auditors) have one
supported shape to bind to.

### Shape

Every row conforms to:

```
(organization_id  uuid,
 legal_order_id   uuid,
 occurred_at      timestamptz,
 entry_kind       text,   -- 'lifecycle' | 'audit' | 'dispatch' | 'remittance'
 action           text,   -- transition name, audit verb, dispatch topic, or 'batch_created'|'batch_settled'|'batch_cancelled'
 actor_user_id    uuid,
 details          jsonb,  -- source-branch-specific payload
 source_row_id    uuid,   -- primary key of the underlying row
 source_table     text)   -- name of the underlying table
```

### Security

The view is declared with `WITH (security_invoker = true)`. It carries no
policies of its own; every branch inherits RLS from its source table, so a
caller sees only rows they could already read directly. `GRANT SELECT` is
issued to `authenticated` only.

### Source branches (current)

1. `garnishment_lifecycle_events` — FSM transitions (single writer path).
2. `garnishment_audit_log` — mutation audit for legal-order rows.
3. `legal_order_event_dispatch_log` joined to lifecycle events —
   notification dispatches emitted by the Phase 5 outbox handlers.
4. `legal_order_remittance_batches` — three virtual rows per batch:
   `batch_created`, `batch_settled` (only when `status='settled'`), and
   `batch_cancelled` (only when `status='cancelled'`).

### Extension rule

Adding a new audit source (dispute log, correspondence log, further
subscriber logs, etc.) is done by appending a `UNION ALL` branch to
`v_legal_order_audit_timeline` in a migration — **not** by publishing a
second view. Consumers bind to `v_legal_order_audit_timeline` and expect
new branches to appear over time without a shape change.

### Non-writer contract

The projection is strictly read-only. It does not, and must never, become
a write path. All legal-order state changes continue to route through the
four sanctioned SECURITY DEFINER writers listed in §6 above, with
`_legal_order_fsm_guard` and `legal-orders-phase5-writer-guard` remaining
active.

## References

- ADR-0093 — Legal Recipient Master Data.
- ADR-0097 — Legal Order Historical Balance & Reporting Contract.
- `supabase/migrations/20260724140000_legal_orders_phase5_event_integration.sql`
- `supabase/functions/outbox-dispatcher/index.ts`
- `src/test/architecture/legal-orders-phase5-writer-guard.test.ts`
- `src/test/architecture/legal-orders-phase8-audit.test.ts`

