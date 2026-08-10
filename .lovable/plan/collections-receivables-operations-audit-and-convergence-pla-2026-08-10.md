# Collections & Receivables Operations — Audit and Convergence Plan

## What Collections is in this ERP

Collections is **not** a financial engine here. It is an operational read layer over
canonical Accounts Receivable truth, plus (today, minimally) a set of hand-offs into
existing payment and statement flows.

The receivable lifecycle actually implemented is:

```text
Invoice confirmed (confirm_invoice_atomic)
  -> journal_entry_lines posted on the AR control account
  -> ar_subledger_entries (posted JE lines on AR control)   [canonical]
  -> finance_ar_open_items (document-level residual, GL-gated)
  -> get_ar_ap_aging_from_ledger (buckets by due date, as-of date)
  -> useAgingReport -> Collections page / AR workspace / Aging report
```

Settlement flows in through `payment_allocations`, `credit_note_applications` and
`customer_credit_balances` (unapplied cash / deposits). Documents with no posted
journal entry never enter AR. This chain is correct and is classified **KEEP** — no
second balance engine will be created.

## Verified findings

### KEEP (do not touch)
- GL-anchored AR chain above (ADRs 0029/0033); `finance_open_items_tieout` drift sensor.
- `Collections.tsx` is read-only: no writes, no shadow balances, actions delegate to
  `RecordCustomerPaymentDialog`, customer ledger and statements.
- `sms_scan_overdue_invoices` is idempotent (guards on `sms_event_outbox` by
  entity + event type).
- `update-overdue-invoices` daily cron: cron-authenticated, audited, notification
  fan-out is non-blocking, and is idempotent through the status transition itself.
- Credit note domain, payment/allocation engine, reversal writers: dependencies only.

### REPAIR (verified defects)
1. **Collections page bucket columns are mislabelled and lose money.**
   `DEFAULT_AGING_BUCKETS` defines `not_due` (<0d), `current` (0–30 overdue),
   `days30` (31–60), `days60` (61–90), `days90` (91+). The page renders columns
   labelled "Current / 1–30 / 31–60 / 60+" mapped to `current/days30/days60/days90`
   and never renders `not_due`. Consequence: every column is shifted one bucket, and
   not-yet-due balance is included in Outstanding but shown in no column, so the row
   columns do not sum to the row total. The bucket filter has the same gap
   (filtering "Current" hides customers whose debt is entirely not yet due).
2. **Customer statements compute receivables from raw invoices.**
   `useCustomerStatements` builds `agingBuckets` and outstanding from
   `invoices.total - amount_paid` with its own JS bucketer and its own credit
   offsetting. This violates the project rule that receivables come only from
   `finance_ar_open_items`, and can disagree with the AR page for the same customer.
3. **Unapplied customer credit is netted inconsistently.** Only
   `get_ar_ap_aging_from_ledger` unions `customer_credit_balances`.
   `finance_ar_open_items` / `get_ar_summary` do not, so the executive dashboard,
   management reports and contact aging drawer report a different net receivable than
   the AR workspace whenever a customer holds unapplied credit.
4. **Suspected residual overstatement for credit applied via
   `apply_credit_to_invoice_atomic`** — `finance_ar_open_items.residual_amount` is
   derived from `payment_allocations` + `credit_note_applications`, not
   `invoices.amount_paid`. Unconfirmed; verification is the first task below and no
   change ships until the live query proves it.

### CONSOLIDATE
- Five independent aging/bucket implementations: `get_ar_ap_aging_from_ledger` (SQL),
  `get_ar_summary`/`get_ap_summary` (SQL), `fetchContactOpenItemAging` (JS, browser
  clock, no as-of date), `fetchTopOpenCounterparties` (ad hoc JS days-overdue),
  `useCustomerStatements` (JS over raw invoices). Converge every consumer onto the
  server-computed bucket, and stop re-deriving buckets client-side in
  `useAgingReport` (it already receives a `bucket` column and ignores it).
- `invoice_reminders` / `invoice_activities` / `invoice_emails` (2026-01) have zero
  consumers in `src/` or edge functions. Either adopt them as the collection-activity
  spine or retire them; they must not remain as a latent second reminder system.

### HARDEN
- `customer_statements` has no unique key on
  `(business_id, contact_id, period_start, period_end)`; dedupe is client-side, so a
  double click or two tabs can create duplicate statements and duplicate sends.
- `send-document-email` writes `document_emails` only on success, so failed sends are
  unauditable; it is a synchronous one-shot even though `email_event_outbox` with
  retry and stuck-row recovery already exists.
- `invoice_reminders` RLS is org-membership-only with no branch scope and no role
  restriction (if adopted, this must be tightened).
- No aging surface carries a currency column: `finance_ar_open_items`,
  `finance_ap_open_items` and `get_ar_summary` return no currency, so multi-currency
  balances are summed as if equal, while `ar_subledger_entries` and
  `customer_credit_balances` do carry currency.

### PRODUCT GAP (not bugs; not built in this wave)
Promise-to-pay lifecycle, AR dispute flagging (the only dispute schema is WMS 3PL
billing), collector/territory assignment and ownership, dunning-level escalation
policy, collections work queue with next-action dates.

### OUT OF SCOPE
Credit-note redesign, payment/allocation engine, reversal writers, POS, WMS billing
disputes, FX revaluation of AR.

## Work plan

**Wave 0 — verification before any change (read-only)**
Live queries to confirm the deployed definitions match the migrations, quantify the
credit-netting divergence per business, and settle finding 4: compare
`finance_ar_open_items.residual_amount` against `invoices.total - amount_paid` for
invoices touched by `apply_credit_to_invoice_atomic`, and read
`finance_open_items_tieout` for non-zero drift. Findings 3 and 4 only proceed if the
data confirms them.

**Wave 1 — Collections page correctness (presentation only)**
Render buckets from the bucket configuration rather than hardcoded labels: add the
not-due column, correct the labels to match the real boundaries, include not-due in
the filter, and surface unapplied-credit rows distinctly instead of silently reducing
the "current" column. No data-layer change.

**Wave 2 — one aging engine**
`useAgingReport` consumes the server `bucket` column instead of re-bucketing.
`fetchContactOpenItemAging`, `fetchTopOpenCounterparties` and the statement generator
stop computing days-overdue and buckets in the browser and read the same RPC with an
explicit as-of date. Statement aging and outstanding come from
`finance_ar_open_items`, keeping the existing statement transaction list (which is
already ledger-derived) unchanged.

**Wave 3 — credit netting parity**
Make unapplied customer credit visible through one path so the AR workspace, the
dashboard and management reports agree, and correct the residual definition if
Wave 0 confirms finding 4. Column shapes are preserved so existing callers and
generated types keep working.

**Wave 4 — statement/communication hardening**
Unique key + idempotency key on statement generation per customer/period, failure
rows recorded in `document_emails`, and bulk statement sends routed through
`email_event_outbox` so retries cannot duplicate a send. Decide and act on the dead
`invoice_reminders` trio.

**Wave 5 — currency**
Carry currency through the open-items and summary projections and group aging by
currency, so no surface adds unlike currencies.

## Verification strategy
- SQL tie-out per business: Collections outstanding = `get_ar_summary` total =
  `customer_ledger_entries` net = AR control account GL balance; assert
  `finance_open_items_tieout` drift is zero.
- Partial-payment walk-through on one invoice (100k → pay 40k → pay 60k) checked on
  the Collections page, statement, dashboard and customer ledger at each step.
- Architecture tests: ban raw `invoices.total - amount_paid` receivable arithmetic and
  client-side bucket boundaries outside the single aging module.
- Idempotency test: repeat statement generation and bulk send for the same
  customer/period and assert one row and one send.
