# Salesperson Performance — Architecture Audit & Remediation

Verified against the live schema and the current implementation
(`src/hooks/useSalespersonDashboard.ts`, `src/pages/sales/SalespersonPerformance.tsx`).

## 1. Business definition

Salesperson Performance is not "who sold the most". In mature ERPs (SAP SD,
Dynamics 365, NetSuite, Odoo Enterprise) it is a **reporting projection over
commercial business events, attributed to an accountable sales owner**, used to
answer four separable questions:

1. Commercial output — booked orders and invoiced net revenue.
2. Quality of revenue — margin, discount depth, returns/credit rate.
3. Consequence of revenue — collections and ageing on accounts they own.
4. Conversion — estimates/orders → invoices.

It legitimately belongs in Sales as a **read-only projection**, but it must own
none of its numbers: revenue is owned by Sales invoicing, receivables and
collections by Finance (`finance_ar_open_items`), credit by the credit-note
domain, POS by the POS domain. Today the page invents its own version of all
four. That is the core defect.

## 2. Attribution model (as-built)

`salesperson_id` exists on exactly two tables: `invoices` and `sales_orders`
(verified via `information_schema`). It exists nowhere on payments, credit
notes, returns, deliveries, POS, or contacts.

Consequences found in code:
- `useInvoices` writes `salesperson_id: invoice.salesperson_id || user.id` —
  authorship silently becomes attribution.
- POS metrics attribute to `pos_transactions.created_by` — that is the cashier,
  a different role from a salesperson.
- Payments attribute to `payments.created_by` — the person who keyed the
  receipt, typically a finance clerk, not the invoice's salesperson.

Verdict: attribution is **document-owned on invoices/orders (correct)** and
**fabricated everywhere else (wrong)**. Downstream events (payment, credit note,
return) must inherit attribution *from the invoice they settle*, never from
whoever created the row.

## 3. Metric dictionary — current vs canonical

| Displayed | What it actually computes today | Canonical source | Verdict |
|---|---|---|---|
| Total Sales | `SUM(invoices.total)` incl. **drafts** + `SUM(pos_transactions.total)` | posted invoice net revenue, one event per commercial transaction | ❌ |
| POS Orders | count of `pos_transactions` (cashier-attributed) | POS domain, only where no invoice exists | ❌ |
| Invoices | count of invoices in range | invoices (posted only) | ⚠️ |
| Cash Collected | `SUM(payments.amount)` by `created_by` | `payment_allocations` → invoice → invoice's salesperson | ❌ |
| Credit Issued | `SUM(invoice.total)` for any invoice with a balance | `credit_notes` (posted), attributed via `original_invoice_id` | ❌ (mislabelled: it is not credit at all) |
| Outstanding | client-side `total - amount_paid` | `finance_ar_open_items.residual_amount` | ❌ |

## 4. Integrity defects confirmed

- **Draft leakage.** No status filter on the invoice query; 2 of 8 invoices in
  this workspace are drafts and are counted as sales.
- **Double counting.** `pos_transactions.invoice_id` exists. Any POS sale that
  spawns an invoice is counted twice (once as POS, once as invoice). Currently
  0 rows are linked, so the bug is latent, not visible.
- **Reversals invisible.** Voided payments (`payments.status`/`voided_at`) are
  summed as collected. Credit notes never reduce sales.
- **AR duplication.** The project already mandates `finance_ar_open_items` as
  the only receivable source (it nets credit-note applications); this page
  recomputes `total - amount_paid` and will overstate receivables the moment a
  credit note is applied.
- **Currency corruption.** `invoices.currency` is ignored; raw amounts are
  summed and rendered with the base-currency formatter.
- **Mixed date semantics.** Invoice `issue_date` (date), POS `created_at`
  (timestamp, string-concatenated `T23:59:59`, timezone-naive), payment
  `payment_date` — three different clocks under one range picker.
- **Attribution loss.** Salespeople with zero invoices never appear; a
  reassigned or departed employee's history is rendered from a live,
  unscoped `profiles` read (whole table, no org filter).
- **No drill-down.** No lineage from a number to its documents.
- **All logic client-side.** Three unaggregated table reads pulled into the
  browser and reduced in JS — no server projection, no reconciliation.

## 5. Duplication audit

No competing salesperson engine exists — this hook is the only one. But it
duplicates, badly, logic already owned elsewhere: AR residual
(`finance_ar_open_items`), payment settlement (`payment_allocations`), and
sales KPI aggregation (`get_sales_dashboard_kpis`). Remediation must consume
those, not add a fourth engine.

## 6. Verdict

- Concept and placement in Sales — ✅ preserve.
- Attribution on invoices/orders — ✅ preserve; propagate to downstream events.
- Every displayed metric — ❌ redesign against canonical sources.
- Client-side aggregation — ❌ move server-side.
- Drill-down, conversion, margin, quota — 🟦 missing; introduce drill-down and
  net-of-credit revenue now; defer quota/pipeline until CRM ownership exists.

The page should exist. Its current numbers should not be trusted.

## 7. Remediation

**A. One server projection.** Add a single SQL function
`get_salesperson_performance(p_org, p_business, p_branch, p_from, p_to)`
returning one row per salesperson, org/business/branch-scoped, with:
- `gross_invoiced`, `credit_notes_value`, `net_revenue` (gross − posted credit
  notes attributed via `credit_notes.original_invoice_id` → invoice salesperson)
- `orders_booked` from `sales_orders` (confirmed only), `invoice_count`
- `cash_collected` from `payment_allocations` joined to the invoice, excluding
  voided/reversed payments, attributed to the *invoice's* salesperson
- `outstanding` and ageing from `finance_ar_open_items` joined to invoice
  salesperson — never recomputed
- `pos_sales` from `pos_transactions` **where `invoice_id is null`**, reported
  as its own column, never folded into invoiced revenue
- explicit posted-status filters and per-currency handling: aggregate only base
  amounts, and return a `has_foreign_currency` flag rather than mixing.

Date basis is fixed per metric: revenue on invoice `issue_date`, credit on
credit-note `issue_date`, cash on `payment_date`, orders on order date — each
labelled in the UI.

**B. Attribution resolution.** Salesperson identity resolves through a snapshot
join on the document, with a display name resolved org-scoped, so departed or
reassigned staff keep their history and still appear.

**C. UI becomes a consumer.** `useSalespersonDashboard` collapses to one RPC
call; the page renders the returned rows and adds row-level drill-down into the
underlying invoices / payments / credit notes for the selected period.

**D. Reconciliation guard.** A SQL test asserting: sum of per-salesperson
`net_revenue` equals the sales report total for the period, `outstanding` ties
to `finance_ar_open_items`, and no POS transaction with an `invoice_id` is
counted twice.

**E. Access.** Managers see all salespeople in scope; a salesperson without a
management role sees only their own row.

## 8. Technical notes

New objects: one SQL function plus grants, one SQL test under
`supabase/tests/`. Rewritten: `src/hooks/useSalespersonDashboard.ts`,
`src/pages/sales/SalespersonPerformance.tsx` (adds drill-down, metric-basis
labels, currency flag). No new tables, no new analytics engine, no changes to
Finance projections.
