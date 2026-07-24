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

## Phase 4 — Operator workspace ✅

- `LegalOrdersWorkspace` shell renders under `/hr/payroll/legal-orders`
  with four tabs (Tasks · Orders · Recipients · Remittances) via
  nested react-router routes; each tab keeps its own deep-linkable URL.
- `LegalOrdersTasks` action inbox: KPI strip (total outstanding,
  orders awaiting approval, past-due count, unlinked count) plus four
  task cards (approvals, unlinked recipients, past-due recipients,
  top concentration). Read-only — no new writer paths.
- Legacy `/hr/payroll/garnishments` now redirects to
  `/hr/payroll/legal-orders/orders`; existing sidebar link is
  unchanged.
- Architecture test `legal-orders-phase4-workspace` pins the shell,
  the nested route structure, the four tab links, and the legacy
  redirect. Phase 3 test updated for the nested route shape.
- Verified: `tsgo` clean on the touched files; all Phase 2/3/4
  architecture tests green (11/11).

## Phase 5 — Cross-domain integration & guardrails (NEXT)

Currently active phase for the next agent.

Before starting, verify:
- `bunx vitest run src/test/architecture/legal-orders-phase*.test.ts`
  is green (11 tests, 3 files).
- `/hr/payroll/legal-orders` renders the Tasks tab with the four KPI
  cards and four task cards; each tab link deep-navigates.
- Legacy `/hr/payroll/garnishments` redirects to
  `/hr/payroll/legal-orders/orders`.
- DB objects from Phases 1–3 exist: tables `legal_recipients`,
  `legal_recipient_types`; view `legal_recipient_outstanding`;
  functions `garnishment_transition`, `legal_recipient_merge`,
  `legal_recipient_statement`; triggers
  `_legal_order_fsm_guard`, `_legal_order_publish_status_event`.

Then execute Phase 5:

1. **Outbox dispatcher subscribers** — register two subscriptions in
   `business_event_subscriptions` for `legal_order.status_changed`
   and `legal_order.payment_posted`:
   - finance drift alert (compares GL liability balance to
     `legal_recipient_outstanding.outstanding_balance` per recipient
     and writes to `finance_integrity_issues` on divergence beyond
     tolerance).
   - ESS notification (writes to `notifications` for the affected
     employee on status transitions to
     `active`/`suspended`/`satisfied`/`released`).
2. **Architecture guard** — extend
   `legal-orders-phase2-seams` (or add
   `legal-orders-phase5-writer-guard`) to grep every migration under
   `supabase/migrations/` for direct `UPDATE ... legal_orders_records
   SET status` and fail unless the SQL lives inside
   `garnishment_transition_impl` / `garnishment_transition` /
   `apply_system_garnishment_transition` /
   `apply_garnishment_payment_to_order`.
3. **ESS surface extension** — the read-only "My Legal Orders" ESS
   page must show recipient display_name and per-order running
   balance sourced from `legal_recipient_statement` (filtered to the
   employee). Do NOT introduce a new RPC; reuse the existing one
   with recipient-scoped filtering already available in the hook.
4. **ADR-0094** — document the event-driven finance/ESS integration
   contract (event names, payload shape, subscriber responsibilities,
   idempotency keys).

Do not open Phase 6 work (localization packs, cross-country
garnishment kinds) until Phase 5 subscribers are live and the drift
alert has fired at least once against seed data.

## Next-agent handoff instructions

1. Read `.lovable/plan.md` end-to-end and confirm Phases 1–4 are marked
   complete.
2. Run the three architecture tests above; if any fail, fix regressions
   before adding new work.
3. Manually smoke-test the workspace: navigate the four tabs, open a
   recipient statement drawer, confirm the legacy redirect.
4. Only then proceed with Phase 5 step 1 (outbox subscribers). Ship
   each numbered step as its own migration + test + plan update before
   moving to the next.
5. After every phase step, append status to this file — never leave it
   stale.

