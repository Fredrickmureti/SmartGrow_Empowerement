# Sales Overview HTTP 400 — Root Cause Found, Minimal Contract-Preserving Repair

## Verdict

The convergence architecture is **not** the problem. The frontend/RPC contract is
intact. One SQL literal inside the new function references credit-note statuses
that do not exist in the database enum, and Postgres rejects the whole call.

## Evidence gathered (live database, not migration files)

1. **RPC exists, single signature, no overloads.**
   `public.get_sales_dashboard_kpis(p_org_id uuid, p_business_id uuid, p_date_from date, p_date_to date, p_branch_id uuid)` → `jsonb`, `SECURITY DEFINER`, `STABLE`, owner `postgres`.
2. **Frontend payload matches exactly.** `SalesDashboard.tsx:128` sends
   `p_org_id, p_business_id, p_date_from, p_date_to, p_branch_id` — same names,
   same types (uuid / date strings). No missing or extra argument.
3. **Grants are correct.** `authenticated` has EXECUTE (`anon` does not, which is
   intended). Not a permission or schema-cache failure.
4. **Every canonical dependency is healthy** — `finance_ar_net_position`,
   `finance_ar_net_position_by_currency`, `finance_ar_open_items`,
   `so_line_balances`, `payment_allocations`, `credit_note_applications` all
   exist with the exact columns the function reads, and all are queryable.
5. **Status columns are enums, not text**: `invoices.status`, `estimates.status`,
   `credit_notes.status` are `USER-DEFINED`.
6. **Enum label inventory:**
   - `invoice_status`: draft, sent, viewed, partial, paid, overdue, cancelled, confirmed, voided — every literal the function uses exists.
   - `estimate_status`: draft, sent, viewed, accepted, rejected, expired, converted — all used literals exist.
   - `credit_note_status`: **draft, issued, applied, void, refunded** — it has **no `voided` and no `cancelled`**.

## Root cause (single, primary)

The new function filters credit notes twice with:

```text
status NOT IN ('draft','void','voided','cancelled')
```

once in the credit-note KPI block and once inside the `top_customers` lateral
(`n.status NOT IN (...)`). Postgres must coerce each literal to
`credit_note_status`; `'voided'` fails with SQLSTATE **22P02 — invalid input
value for enum credit_note_status**. PostgREST maps 22P02 to **HTTP 400**, which
is exactly the observed failure. It fires on every call regardless of scope or
date range, and regardless of whether any credit notes exist, because coercion
happens at plan time.

Fix classification: **database function repair — literal/enum contract defect**.
Not a frontend, deployment, cache, permission, or architectural defect.

## The repair (smallest safe correction)

A new migration that `CREATE OR REPLACE`s `get_sales_dashboard_kpis` with only
the two credit-note predicates changed, to the real lifecycle:

```text
status NOT IN ('draft','void')
```

`issued`, `applied` and `refunded` are live commercial credit notes and stay
counted; `draft` is not yet a document and `void` is cancelled. Nothing else in
the function body changes — GL revenue, `finance_ar_net_position` receivables and
aging, allocation-first cash, `so_line_balances` fulfilment, and the
accepted+converted quote cohort all stay exactly as the convergence work left them.

## Regression protection

- Extend `src/test/architecture/sales-dashboard-projection.test.ts` with an
  enum-literal guard: every status literal the dashboard migration compares
  against `credit_notes`, `invoices` and `estimates` must be a real label of the
  corresponding enum (labels asserted from a checked-in list), so a future edit
  cannot reintroduce a phantom status and 400 the page again.
- Keep the existing ratchets that forbid local AR/aging/payment recomputation.
- After the migration, verify the RPC end-to-end from the app (page loads, KPI
  object populated) rather than declaring success on the migration alone.

## Documentation to correct

`docs/sales-audit.md` and `mem/features/sales-overview-cockpit.md` currently
state credit notes exclude `draft/void/voided/cancelled`. Update both to the
actual `credit_note_status` lifecycle (`draft`, `issued`, `applied`, `void`,
`refunded`; excluded = `draft`, `void`).

## Explicitly not doing

No RPC signature change, no frontend contract change, no reverting to invoice
arithmetic, raw payment sums, `customer_credit_balances`, or status-string
fulfilment heuristics, no deleting functions or migrations, no fake zeros.

## Follow-up noted, not silently changed

The error card already surfaces `error.message`, but PostgREST `details`/`hint`
are dropped. A small non-blocking improvement is to log `code`/`details`/`hint`
to the console while keeping the user-facing text safe. Say the word and I will
include it; otherwise the fix stays scoped to the enum defect.
