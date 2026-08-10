---
name: Sales Overview cockpit source-of-truth map
description: get_sales_dashboard_kpis is a projection only — receivables/aging from finance_ar_net_position, cash from payment_allocations, fulfilment from so_line_balances, quotes count 'converted' as won
type: feature
---

## Rule
`get_sales_dashboard_kpis` is the single Sales Overview reader, and it is a
**projection** — it owns no business rules. Each figure is selected from the
engine that owns the event:

| Figure | Source |
| --- | --- |
| Revenue | `get_account_movements` (posted GL, via `fetchGLTotals`) |
| Receivable + aging | `finance_ar_net_position` (base currency, credit-netted) |
| Mixed-currency flag | `finance_ar_net_position_by_currency` |
| Cash applied / unapplied | `payment_allocations` vs `payments.amount` |
| Orders to fulfil | `so_line_balances.quantity_open_to_deliver > 0` |
| Quote conversion | `estimates`, period cohort, `accepted` **and** `converted` are won |
| Credit notes | `credit_notes`, excluding `draft` and `void` |
| Top customers | invoiced net of `credit_note_applications` |

## Forbidden
- Never sum `finance_ar_open_items.residual_amount` (document currency) — use
  the net-position view, or `base_residual_amount` if you must go item-level.
- Never read `customer_credit_balances`; credit netting already happens inside
  `finance_ar_net_position`.
- Never subtract credit from an aging bucket — buckets are gross open amount;
  credit is netted only at the receivable total.
- Never count pending sales orders from a status list.
- Never include voided/unreconciled payments in cash figures.

## Date semantics
Period-based: revenue, cash, credit notes, quotes. As-of-today: receivable,
aging, invoice pipeline, orders to fulfil. The RPC returns `meta.basis` so the
UI can label each card, plus `meta.as_of` and `meta.mixed_currency`.

## Guards
- `src/test/architecture/sales-dashboard-projection.test.ts`
- `supabase/tests/sales_dashboard_reconciliation_test.sql`
