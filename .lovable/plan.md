# Enterprise Legal Orders (Garnishments) — Execution Plan

Multi-phase hardening of the Legal Orders subsystem to enterprise-grade
quality (SAP HCM / Oracle HCM / Workday / D365 F&O / Odoo parity).

## Phase 1 — Recipient master data ✅

- Tables `legal_recipient_types` (pack-seeded catalog, 9 industry categories)
  and `legal_recipients` (org-scoped aggregate).
- Structural dedupe unique index on
  `(organization_id, contact_id, recipient_type_code, jurisdiction_country,
  jurisdiction_region)`.
- `legal_orders_records.recipient_id` FK + backfill from `payee_contact_id`.
- Extended `public.legal_orders` view with recipient columns.
- `legal_recipient_merge(source, target)` RPC.
- `src/hooks/useLegalRecipients.ts` client seam.
- ADR-0093.

## Phase 2 — Lifecycle & engine seals ✅

- DB trigger `_legal_order_fsm_guard` — rejects any direct `status` write
  from `authenticated`/`anon`; canonical `garnishment_transition()`
  (SECURITY DEFINER, owner=postgres) is the only sanctioned writer.
- Trigger `_legal_order_publish_status_event` — writes
  `legal_order.status_changed` events into `business_event_outbox` on
  every accepted transition. Finance/audit/analytics subscribe there.
- Architecture test `legal-orders-phase2-seams` pins:
  no sibling status writer in app code, single `computeGarnishments`
  definition, `compute-payroll` as sole engine consumer, full FSM
  coverage in the RPC.

## Phase 3 — Recipient financial continuity ✅

- View `public.legal_recipient_outstanding` — per-recipient rollup of
  accrued (via `garnishment_ledger`) vs. remitted (via
  `legal_order_remittance_lines`), with outstanding balance, oldest
  accrual date, employee/order counts, and contact-linkage flag.
- Function `public.legal_recipient_statement(recipient_id, from, to)` —
  chronological accrual/remittance statement for reconciliation
  (accruals positive, remittances negative, running balance rendered
  client-side).
- Hooks `useLegalRecipientOutstanding`, `useLegalRecipientStatement`.
- Route `/hr/payroll/legal-orders/recipients` — recipient workspace tab
  with KPI cards (total outstanding, overdue count, unlinked count),
  drill-down statement sheet.
- Architecture test `legal-orders-phase3-recipient-continuity` pins the
  migration objects, hooks, and route.

## Phase 4 — Operator workspace (next)

- Recipients tab alongside Orders / Remittance Batches / Reports / Audit
  in a single `/hr/payroll/legal-orders/*` shell.
- Task-oriented dashboard: "orders awaiting approval",
  "recipients past due", "unlinked recipients blocking bank file".
- Bulk-link recipient-to-contact wizard using
  `useMergeLegalRecipients` + create-contact-from-recipient shortcut.

## Phase 5 — Cross-domain integration & guardrails

- Subscribe `legal_order.status_changed` and `legal_order.payment_posted`
  in the outbox dispatcher for finance drift alerts and ESS notifications.
- Contract test: any new migration touching `legal_orders_records.status`
  must go through `garnishment_transition_impl` (arch grep).
- ESS surface: read-only "My Legal Orders" already exists — extend with
  recipient name + running balance from `legal_recipient_statement`.
