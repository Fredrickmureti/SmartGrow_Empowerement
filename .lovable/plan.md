# Recurring Invoicing — Audit Findings and Convergence Plan

## 1. What exists today (verified in code + database)

**Data model** — `recurring_invoices` (template) + `recurring_invoice_items` (lines).
Columns: customer, frequency (weekly/biweekly/monthly/quarterly/yearly), `start_date`,
`end_date`, `next_run_date`, `last_run_date`, `is_active`, `auto_send`, `auto_confirm`,
`days_before_due`, `invoices_generated`, org/business/branch. Invoices carry
`source_recurring_id`. Verified: no billing-period column, no run/execution table,
no unique constraint of any kind beyond the primary key, and no `%recurring%`
database function. Current data: 0 templates, 0 generated invoices — so there is
no production billing history at risk from a corrective change.

**Two independent generation engines exist.**

1. `supabase/functions/process-recurring-invoices` — cron `0 6 * * *`. Selects
   active rows with `next_run_date <= today`, loops, inserts the invoice row and
   items directly, resolves GL accounts with its own heuristic (name matching on
   "receivable"/"sales"/"tax"), hand-builds AR/Revenue/Tax lines and posts through
   `post_journal_entry_atomic`.
2. `generateInvoiceNow` in `src/hooks/useRecurringInvoices.ts` — runs in the
   browser. Inserts the invoice and items directly from the client, then calls
   `confirmInvoiceAndPostGL` → `confirm_invoice_atomic`.

They disagree on nearly everything that matters: the cron path never sets
`source_recurring_id` (so generated invoices are not traceable to their template),
never honours `auto_confirm`, and calls `get_next_invoice_number` with only
`_org_id` while the client passes org **and** business. The client path ignores
`auto_send`, and releases stock (`releaseStock: true`) where the cron path never
does. Same button, two different financial outcomes.

## 2. Correctness problems found

**Duplicate billing is possible.** The only guard is a read-then-compare
(`last_run_date >= next_run_date`) with no lock, no claim state, and no unique
constraint. Two overlapping cron runs, or a cron run concurrent with a user
pressing "Generate now", both pass the check and both mint an invoice for the same
period. A crash after invoice creation but before the schedule update produces the
same duplicate on the next run.

**Silent revenue loss is possible.** The schedule is advanced by a separate
`UPDATE` that is not in the same transaction as invoice creation. Separately, when
`end_date` has passed the template is deactivated *before* generating billing dates
that fell due earlier — the final period is never invoiced.

**Generated invoices can land in states nobody watches.** When GL posting fails,
the cron path rewrites the invoice back to `draft` and moves on; when `auto_send`
is on it then flips the same invoice to `sent`. An invoice can therefore be emailed
to the customer while unposted, or sit as a draft with no alert, no retry and no
record that a billing event failed.

**There is no billing period.** An invoice records only an issue date, so nothing
says which service period it covers, nothing can answer "was September billed?",
and no idempotency key can be derived.

**There is no audit trail.** Every outcome — skip, generate, post-failure,
email-failure — exists only as an edge-function console log. An operator cannot
answer why an invoice was or was not generated.

**Tax and accounts bypass canonical resolution.** Line `tax_rate` is a frozen
number on the template, and the cron path resolves GL accounts by string-matching
account names instead of the default-account settings the rest of Sales uses.

## 3. Target architecture

One engine, in the database, called identically by cron and by the UI.

```text
Template (recurring_invoices)
   -> due occurrence = (template, period_start, period_end)
   -> claimed exactly once  (unique key + SKIP LOCKED)
   -> invoice created + lines + tax     [one transaction]
   -> confirm_invoice_atomic if auto_confirm
   -> schedule advanced                 [same transaction]
   -> run row recorded (success/failure, reason, invoice id)
   -> notification queued separately (never blocks the financial event)
```

Principles taken from mature billing systems (Odoo subscriptions, NetSuite
recurring billing, Stripe/Chargebee invoicing): the billing *occurrence* is the
durable unit of work, not the template's `next_run_date`; delivery is decoupled
from accounting; and the schedule advances only on a committed successful
occurrence.

## 4. Implementation phases

**Phase 1 — Occurrence ledger and idempotency (highest financial risk).**
New table `recurring_invoice_runs`: template id, org/business/branch,
`period_start`, `period_end`, status (`claimed` / `generated` / `posted` /
`failed` / `skipped`), invoice id, failure reason, attempt count, timestamps.
Unique index on `(recurring_invoice_id, period_start)` — this is the idempotency
key. Add `billing_period_start` / `billing_period_end` to `invoices`, backfillable
and nullable. Grants + RLS mirroring `recurring_invoices`.

**Phase 2 — Single canonical generation RPC.**
`generate_recurring_invoice_occurrence(_recurring_id, _period_start)`,
SECURITY DEFINER, doing in one transaction: lock the template
`FOR UPDATE SKIP LOCKED`; insert the run row (unique violation ⇒ return the
existing outcome, no second invoice); validate template, customer, currency,
business/branch coherence; compute period end and due date from `days_before_due`;
allocate the number via `get_next_invoice_number(_org_id, _business_id)`; insert
the invoice with `source_recurring_id` and billing period; snapshot lines with
template price, tax rate and product; call `confirm_invoice_atomic` when
`auto_confirm` is set (respecting fiscal-period locks, which that function already
enforces); advance `next_run_date`/`last_run_date`/`invoices_generated`; write the
run outcome. Any failure rolls the whole occurrence back and records a `failed`
run — the schedule does not advance and the period is retried next cycle.

**Phase 3 — Rewrite the cron worker as a thin driver.**
The edge function enumerates due occurrences (including catch-up periods, capped)
and calls the RPC once per occurrence. All invoice building, GL posting, account
heuristics and schedule mutation are deleted from it. Per-template failures are
isolated, recorded, and never block other tenants. End-date handling changes to:
generate every occurrence up to and including `end_date`, then mark the template
`completed` rather than silently deactivating.

**Phase 4 — Notification and document pipeline, decoupled.**
After a committed, posted occurrence, the worker enqueues delivery through the
existing document/notification pipeline (`ensureDocumentRecord` +
`materializeAndSubmitIntent`, plus the existing `send-invoice` path) and records
the delivery result on the run row. Email failure marks the run
`posted, delivery_failed` and is retried on the next sweep; it never alters the
invoice's accounting status. `auto_send` no longer rewrites invoice status.

**Phase 5 — Client convergence.**
`generateInvoiceNow` becomes a single `supabase.rpc` call to the same function
with the current due period; all client-side invoice/line/GL construction is
deleted from `useRecurringInvoices.ts`. "Generate now" thus becomes idempotent and
identical to the scheduled path.

**Phase 6 — UI truthfulness and observability.**
The template detail/peek surfaces gain a Billing History section reading
`recurring_invoice_runs` (period, outcome, invoice, failure reason, delivery
state). Labels are corrected so "Payment Terms" reflects `days_before_due` as a
due-date offset, and the two switches describe what the backend now actually
guarantees.

**Phase 7 — Tests.**
Concurrency: two simultaneous RPC calls for one period yield one invoice.
Crash-resume: an occurrence interrupted after invoice creation does not duplicate.
Schedule integrity: a failed occurrence leaves `next_run_date` unchanged.
Calendar: Jan 31 monthly, February, leap years, quarterly/yearly month-end.
End date: the final period is billed, then the template completes.
Accounting: a recurring invoice's journal entry is indistinguishable from a
manually confirmed invoice's. Isolation: one broken template does not stop others.

## 5. Deliberately out of scope

Proration, mid-term amendments with temporal versioning, and a full subscription
contract object are real enterprise capabilities this system does not model today.
They are noted as future work rather than introduced here, because adding them
before the occurrence ledger exists would build versioning on an unsafe base.
