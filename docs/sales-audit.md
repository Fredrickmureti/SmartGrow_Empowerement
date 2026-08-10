# Sales Module — Per-Tab Audit (Odoo Parity)

This is the durable verification artefact produced by the Sales-module audit.
Each tab below records: data scope, atomicity status, GL/inventory linkage,
and remaining Odoo gaps. Updated alongside the migration that introduced
`convert_estimate_to_so_atomic` and `confirm_invoice_atomic`.

## Dashboard (`/sales/dashboard`)
Server-aggregated KPIs via the single RPC `get_sales_dashboard_kpis`, which is
a **projection only**: receivables and aging come from
`finance_ar_net_position` (base currency, credit-netted), cash from
`payment_allocations` (voided/unreconciled payments excluded, unapplied cash
reported separately), open fulfilment from `so_line_balances`, quote
conversion from the period estimate cohort counting `accepted` and
`converted` as won, and revenue from posted GL via `fetchGLTotals`. The RPC
returns `meta` (as-of date, period, mixed-currency flag, per-metric date
basis) so every card can state its own semantics. Strict branch equality when
a branch is selected (no NULL widening). Three-state UI: auth-warming → soft
spinner with auto-retry; real RPC failure → error card; success (including
all-zero workspaces) → KPI cards rendered with zeros. GL revenue failure now
renders an explicit "Unavailable" state with retry instead of a silent zero.
Guards: `src/test/architecture/sales-dashboard-projection.test.ts`,
`supabase/tests/sales_dashboard_reconciliation_test.sql`.


## Invoices (`/sales/invoices`)
Branch-scoped via `applyBranchFilter` on every list query. Direct-invoice
confirmation defaults to `confirm_invoice_and_release_stock_atomic`: it posts
Revenue/AR, creates the auto Delivery Note for stockable lines, and completes
that delivery in the same user action. Stock still moves only through Delivery
Notes and `stock_movements`; there are no direct product-quantity edits.
Account resolution (contact-AR override, per-product revenue, heuristic
fallbacks) stays client-side for fast UX feedback; resolved entries are sent to
the RPC.

## Recurring Invoices
Generated invoices inherit branch + business from the template; the
`generate_recurring_invoices` cron writes draft invoices that follow the same
confirmation path.

## Estimates / Quotations
Branch-scoped reads. Two atomic conversions: `convert_estimate_to_invoice_atomic`
and `convert_estimate_to_so_atomic`. Both copy items verbatim with the
tax-exclusive `line_total` convention and flip the estimate to `converted` in
the same transaction. No more partial-conversion states.

## Proforma Invoices
Non-accounting commercial document: no GL, AR, tax-liability, inventory or
payment effect. Creation: `create_proforma_atomic` (business-scoped numbering
under an advisory lock, server-recomputed totals). Lifecycle:
`set_proforma_status_atomic` with a trigger blocking direct status writes.
Conversion: `convert_proforma_to_invoice_atomic` (atomic, idempotent,
business-match enforced) — after which the proforma is frozen and undeletable.
Nightly `expire_overdue_proformas()` sweeps overdue sent proformas. Same
branch-scope rules as estimates. Verdict: `docs/audit/2026-08-08-proforma-domain-verdict.md`.


## Sales Orders (`/sales/orders`)
Branch-scoped reads. Confirmation: `confirm_sales_order_atomic`. Conversion to
invoice: `convert_so_to_invoice_atomic`. Reservation release on cancel:
`release_sales_order_reservations_atomic`. All stock-affecting operations are
atomic.

## Delivery Notes
Completion: `complete_delivery_atomic` — creates stock_movements, decrements
`warehouse_stock`, links the SO line, and posts COGS/Inventory through the
canonical journal RPC in one transaction. This is the single source of truth
for inventory movement on sale.

## Customer Payments
`record_payment_atomic`, `record_multi_invoice_payment`, and
`record_advance_payment` cover the three flows. Each posts the cash/AR JE,
updates `amount_paid` on every linked invoice, and recomputes invoice status
(paid/partial) inside one transaction. Branch-scoped via `applyBranchFilter`.

## Customer Statements
Read-only, branch + date-range scoped. No write paths.

## Sales Returns
Branch-scoped. Stock restoration on approval routes through
`restore_invoice_stock_atomic` to keep inventory and GL consistent.

## Credit Notes
Branch-scoped. Apply-to-invoice runs through `apply_credit_to_invoice_atomic`
which decrements the customer's open balance and updates invoice status in
one transaction.

## Salesperson View
Reads only; filters all sales-objects by `salesperson_id` plus the standard
org/business/branch filters.

## Customers (Contacts surface)
Workspace-wide entity; branch scoping applied at the consuming sales modules
rather than on the contact itself. `default_receivable_account_id` on the
contact is honored by `confirm_invoice_atomic` (via the client-side
resolver) so AR overrides post to the correct account.

## Cross-branch contamination — verified clean
- DB: business-match triggers on invoices, payments, deliveries, SO→invoice,
  proforma→invoice, and POS→credit-invoice prevent cross-business writes.
- App: every Sales hook applies `applyBranchFilter`, and the dashboard RPC
  uses strict branch equality when a branch is supplied.
- Reads default to org+business; branch is additive, never widening across
  siblings.

## Remaining Odoo gaps (intentional / accepted deviations)
- We do not implement Odoo's "lock confirmed sales orders" preference; SOs
  remain editable until invoiced. Justification: SMB workflow flexibility
  outweighs the audit benefit at our current scale.
- We do not yet support Odoo's pricelist engine (per-currency, per-customer-tier
  unit prices). Planned, not blocking.
- Multi-step delivery (pick → pack → ship) is collapsed into a single
  Delivery Note completion step. Sufficient for SMB; warehouse-grade flows
  would require a dedicated module.
