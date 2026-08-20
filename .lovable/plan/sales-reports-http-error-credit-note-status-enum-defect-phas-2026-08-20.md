# Sales Reports HTTP error — credit_note_status enum defect (Phase 5 fix)

## VERIFIED FACT — root cause

The Phase 4 sales-analysis engine filters credit notes with statuses that do not
exist in the database enum.

- Live enum labels (queried, not assumed):
  - `credit_note_status` = draft, issued, applied, **void**, refunded — there is
    no `cancelled` and no `voided`.
  - `invoice_status` = draft, sent, viewed, partial, paid, overdue, cancelled,
    confirmed, voided — the invoice predicates are fine.
- Migration `20260820103610_*.sql` compares `credit_notes.status NOT IN
  ('draft','cancelled','voided')` in two places:
  - line 68 — the `cn` CTE inside `finance_sales_analysis`
  - line 299 — `finance_sales_revenue_reconciliation`
- Postgres must coerce each literal to `credit_note_status` at plan time, raises
  22P02, and PostgREST returns the error shown on screen. It fires on every call
  regardless of data or filters.

This is the exact same class of defect already documented for the Sales
Dashboard (`docs/sales-audit.md`), reintroduced in the new engine.

## The fix (smallest correct change)

One migration that `CREATE OR REPLACE`s both functions with only the two
credit-note predicates changed to the real lifecycle:

```text
c.status NOT IN ('draft','void')
```

`issued`, `applied` and `refunded` are live commercial credit notes and must keep
reducing net sales; `draft` is not yet a document and `void` is cancelled.
Invoice predicates, GL reconciliation, dimension handling, paging, org gate,
`SECURITY DEFINER` and `search_path` all stay byte-identical.

## Regression protection

Extend the enum-literal ratchet already used for the dashboard so it also covers
the sales-analysis migration: every status literal compared against
`credit_notes`, `invoices` or `estimates` in any finance/sales migration must be
a real label of the corresponding enum. This prevents a third occurrence.

## Verification before closing

1. Call `finance_sales_analysis` and `finance_sales_revenue_reconciliation` from
   an authenticated session for a real period — expect rows/zeros, not 22P02.
2. Load `/reports/sales` in the preview and confirm the error card is gone and
   the totals row renders.
3. Run the sales-analysis architecture test plus the enum ratchet.

## Not doing

No signature change, no frontend contract change, no re-aggregation in React,
no other Phase 5 work until this is verified green.

## Then — Phase 5 (report taxonomy & security closure)

Resumes unchanged after this fix: direct-RPC and drill-down isolation tests for
all four reports across org / business / branch, the cross-org membership
matrix, and a security-linter pass over this report family.
