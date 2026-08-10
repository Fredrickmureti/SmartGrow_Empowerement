# Sales Overview — Order-to-Cash Cockpit Audit & Convergence

## What the Sales Overview must be

In SAP / Oracle Fusion / D365 / NetSuite / Odoo, the Sales Overview is a **read-only projection surface** over the Order-to-Cash chain plus an **exception/action center**. It owns no business rules. Every figure belongs to the domain that owns the underlying business event:

```text
Lead → Estimate → Sales Order → Fulfilment → Delivery → Invoice → Payment → AR → Collections → GL
```

The page today calls one server function, `get_sales_dashboard_kpis`, plus `fetchGLTotals`. The function is server-side (good) but it **re-implements** several domain rules instead of consuming the hardened projections built during the AR/Collections/Estimates work. Below is the evidence-backed verdict per metric.

## Metric verdicts (evidence from the live database and the RPC body)

| Metric | Status | Evidence | Canonical owner |
|---|---|---|---|
| Revenue (GL) | ✅ Correct | `fetchGLTotals` → `get_account_movements`, posted entries only, org+business+branch scoped | Finance/GL |
| Receivables total & aging | ❌ Wrong | RPC sums `finance_ar_open_items.residual_amount` (document currency) — the projection exposes `base_residual_amount` for exactly this reason | `finance_ar_net_position` |
| Customer credit | ❌ Wrong | RPC reads `customer_credit_balances` directly, which is explicitly non-canonical; `finance_ar_customer_credit` exists | `finance_ar_customer_credit` |
| Credit netting into aging | ❌ Wrong | RPC subtracts total credit from the `current` bucket, which can drive that bucket negative and makes buckets not sum to the displayed total | `finance_ar_net_position` |
| Payments Received | ❌ Wrong | RPC sums `payments.amount` with **no status filter** — voided / unreconciled payments are included, and allocation-first semantics (ADR 0027) are ignored | `payment_allocations` |
| Quote Conversion | ❌ Wrong | Estimate enum is `draft,sent,viewed,accepted,rejected,expired,converted`; RPC counts only `accepted`. Live data holds estimates in `converted` only, so the card reports **0%** while every quote actually converted. Also all-time counts under a period selector | Estimate lifecycle |
| Orders to Fulfill | ❌ Wrong | RPC excludes `delivered,cancelled,invoiced,closed,completed`; three of those are **not in the `sales_order_status` enum**, and the real terminal state `fulfilled` is **not excluded** → fulfilled orders counted as pending. Ignores `so_line_balances` | `so_line_balances` |
| Top Customers | ⚠ Needs improvement | Sums `invoices.total` gross — no credit-note netting, no currency normalisation | Invoice + Credit Note |
| Credit Notes | ⚠ Needs improvement | Sums `total` across currencies; excludes `draft,void` but not `cancelled` | Credit Note engine |
| Recent Payments | ⚠ Needs improvement | Raw `payments` read, no status filter, no allocation context | Payment engine |
| Invoice pipeline | ⚠ Needs improvement | Recomputes "overdue" inline instead of deriving it from residual (payability rule) | Invoice payability service |
| Date semantics | ❌ Wrong | One selector drives period flows *and* point-in-time balances; documented per metric below | — |
| Error handling | ⚠ Needs improvement | RPC-level failure is handled well, but GL revenue failure sets `null` → renders **0** silently | — |
| Branch/business scope | ✅ Correct | Every query filters org + optional business + optional branch consistently | — |

## Root cause

`get_sales_dashboard_kpis` predates the AR/Collections hardening. It reproduces aging, credit netting, payment totals, quote lifecycle and fulfilment rules locally rather than selecting from the projections that now own them. This is Rule 1 and Rule 9 drift, not a UI problem.

## Canonical architecture to converge toward

```text
Revenue           → get_account_movements (GL, posted)                [already correct]
Receivable+Aging  → finance_ar_net_position (base currency, credit-netted)
Per-currency AR   → finance_ar_net_position_by_currency (mixed-currency disclosure)
Cash collected    → payment_allocations joined to non-void payments
Quote conversion  → estimates, cohort by issue_date, converted ∪ accepted
Orders to fulfil  → so_line_balances (quantity_open_to_deliver > 0)
Credit notes      → credit_notes, non-terminal, base currency
Top customers     → invoiced net of applied credit notes
```

## Implementation plan (ordered by financial risk)

1. **Migration — rewrite `get_sales_dashboard_kpis`**
   - Receivable + aging: select from `finance_ar_net_position` (already base-currency and credit-netted). Return `open_amount`, `credit_amount`, `net_amount` and the five buckets verbatim; stop bucketing locally and stop touching `customer_credit_balances`.
   - Add `mixed_currency` flag from `finance_ar_net_position_by_currency` (>1 currency in scope) so the UI can disclose base-currency conversion.
   - Payments: sum `payment_allocations.amount` for non-void/non-unreconciled payments in the period, and return `unapplied` separately (payment total less allocated). Two distinct business events, two numbers.
   - Estimates: period-cohort on `issue_date`; `converted` counts as won; `accepted` counts as won-not-yet-converted; open = `sent,viewed`; report both count-based and value-based conversion.
   - Sales orders: count distinct `sales_order_id` from `so_line_balances` where `quantity_open_to_deliver > 0`, plus a partially-fulfilled count.
   - Credit notes: exclude `cancelled` as well; keep period basis on `issue_date`.
   - Top customers: net applied credit notes out of invoiced totals.
   - Invoice pipeline overdue: derive from residual via the open-items projection rather than the inline `total - amount_paid` expression.
   - Return a `meta` object carrying, per metric, its date basis (`period` vs `as_of`) and the as-of date.

2. **Frontend — `src/pages/sales/SalesDashboard.tsx`**
   - Label every card with its semantics: "Revenue (GL, posted, this period)", "Cash Applied (this period)", "Outstanding Receivable (as of today)", "Aging (as of today)".
   - Show unapplied payments as a sub-line under Cash Applied.
   - Surface a mixed-currency note when the flag is set.
   - Replace the silent GL-revenue `null → 0` path with an explicit "unavailable" state and retry, matching the KPI error card.
   - Drill-downs: carry business, branch and the active date range into the target route query string; aging buckets link to Collections filtered by bucket; Orders-to-Fulfill links to the open-delivery filter.

3. **Guards**
   - SQL test asserting Sales Overview receivable + buckets equal `finance_ar_net_position` for the same scope, and that bucket sum equals net.
   - Architecture test banning `customer_credit_balances` and bare `residual_amount` sums inside the sales dashboard function and page.

4. **Docs/memory** — record the Sales Overview source-of-truth map alongside the existing collections/open-items entries.

## Scope boundaries

Fulfilment exceptions, backorders and dispatch failures stay in Warehouse/Delivery; the overview links to them, it does not recompute them. No new aging engine is created — `finance_ar_net_position` is consumed as-is.

## Regression risks

Receivable and aging numbers will move once base-currency and canonical credit netting apply; quote conversion will jump from 0% to its true value; Orders-to-Fulfill will drop as fulfilled orders stop counting. These are corrections, and the reconciliation test locks them against Finance.
