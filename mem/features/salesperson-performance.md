---
name: Salesperson performance projection
description: get_salesperson_performance is the only source for per-salesperson revenue, cash, receivables and POS; attribution inherits from the invoice, never from created_by
type: feature
---

## Canonical projection
`public.get_salesperson_performance(org, business, branch, from, to)` is the
only owner of per-salesperson metrics; `get_salesperson_performance_documents`
provides the drill-down lineage. `src/hooks/useSalespersonDashboard.ts` is a
thin consumer — no aggregation in the browser.

## Attribution rule
`salesperson_id` exists only on `invoices` and `sales_orders`. Every downstream
event (payment, credit note, receivable) inherits attribution **from the invoice
it settles or reverses** — never from `created_by`, which is authorship.

## Metric sources (do not recompute)
- Revenue: posted invoices (`draft`/`cancelled`/`voided` excluded), issue_date basis.
- Credit: `credit_notes` via `original_invoice_id`/`invoice_id`, issue_date basis.
- Cash: `payment_allocations` joined to non-voided `payments`, payment_date basis.
- Outstanding: `finance_ar_open_items.base_residual_amount` — never `total - amount_paid`.
- POS: `pos_transactions` **where `invoice_id IS NULL`**, reported separately so
  an invoiced POS sale is never counted twice.
- Base amounts = `amount * COALESCE(NULLIF(exchange_rate,0),1)`.

## Access
Owners/admins/accountants/super_admins see the team; anyone else sees only self.

## Guard
`supabase/tests/salesperson_performance_reconciliation_test.sql`
