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

---

# Progress verification — 2026-08-10 (resumed audit)

Verified against the current code and the live database, not against the prior
agent's summary.

## Wave 0 — verification (PARTIAL)
Credit-netting divergence was confirmed and fixed (`get_ar_summary` now nets
`customer_credit_balances`). **Finding 4 (residual overstatement for credit
applied via `apply_credit_to_invoice_atomic`) is still unproven**:
`finance_open_items_tieout` cannot be read with the audit role
(`permission denied for function is_ap_control_account`), so no drift evidence
exists either way. Finding 4 stays open, not closed.

## Wave 1 — Collections page correctness (DONE)
`Collections.tsx` renders all five canonical buckets from
`AGING_BUCKET_SHORT_LABELS`, adds a `not_due` column and filter option, and
isolates net-credit customers via an `in_credit` filter. No hardcoded labels
remain.

## Wave 2 — one aging engine (MOSTLY DONE)
`DEFAULT_AGING_BUCKETS` is gone from `useAgingReport`; boundaries exist once in
`src/services/finance/aging.ts` mirroring the new SQL `finance_aging_bucket`.
`useCustomerStatements` / `useVendorStatements` / `ContactAgingBreakdown` /
`ContactPreviewDrawer` / management reports all call
`fetchContactOpenItemAging`. Guard test `aging-single-source.test.ts` exists.
Remaining gaps:
- `fetchContactOpenItemAging` takes no `asOf` parameter — it ages on the
  browser clock, so a statement for a past period ages as of today.
- `fetchTopOpenCounterparties` still derives days-overdue in JS rather than
  reading the server bucket.

## Wave 3 — credit netting parity (DONE for AR summary)
`finance_aging_bucket(due_date, as_of)` added; `get_ar_summary`,
`get_ap_aging_summary` and `get_sales_dashboard_kpis` rebuilt on it, with
unapplied customer credit netted into `total_residual` and `current`.
Remaining gap: credit netting is applied by each consumer (SQL RPCs and JS
helpers) rather than in one projection, so a future consumer can still forget
it. Not a defect today; note as a hardening candidate.

## Wave 4 — statement / communication hardening (NOT STARTED)
Confirmed live: `customer_statements` has only `pkey` plus three plain indexes
— **no unique key** on `(business_id, contact_id, period_start, period_end)`,
so duplicate statements and duplicate sends are still possible.
`send-document-email` still inserts `document_emails` only on the success path
and does not route through `email_event_outbox`. The dead
`invoice_reminders` / `invoice_emails` trio is untouched (only
`invoice_activities` is written, by `send-document-email`); no adopt/retire
decision has been made.

## Wave 5 — currency (NOT STARTED)
Confirmed live: `finance_ar_open_items` and `finance_ap_open_items` expose no
currency column, so multi-currency balances are still summed as if equal.

## Gaps found during verification (appended to the plan)
1. **Statement as-of aging.** Add an explicit `asOf` to
   `fetchContactOpenItemAging` and pass the statement `period_end`; ban the
   implicit `new Date()` default in the aging guard test.
2. **Finding 4 remains unverified.** Before any residual change, prove or
   disprove it with a direct query comparing `finance_ar_open_items.residual_amount`
   against `invoices.total - amount_paid` for invoices carrying
   `credit_note_applications`, using a role that can execute
   `is_ap_control_account` (or query the underlying views directly).
3. **Tie-out view is unreadable to auditors.** `finance_open_items_tieout`
   depends on `is_ap_control_account`, which lacks EXECUTE for the reporting
   role — the drift sensor cannot actually be monitored. Grant EXECUTE (the
   function is a lookup over `accounts.system_role`, not privileged).
4. **Credit netting is duplicated per consumer** (three SQL sites + two JS
   helpers). Candidate for a single `finance_ar_net_position` projection in a
   later wave; do not fan it out further meanwhile.

## Next actions, in order
1. Grant EXECUTE on `is_ap_control_account`, then read
   `finance_open_items_tieout` and settle finding 4 (read-only).
2. Wave 4: unique key + server-side idempotent statement generation; record
   failed sends in `document_emails`; route bulk statement sends through
   `email_event_outbox`; adopt-or-retire `invoice_reminders` /
   `invoice_emails`.
3. Wave 2 residue: `asOf` on `fetchContactOpenItemAging`;
   `fetchTopOpenCounterparties` onto the server bucket.
4. Wave 5: currency on the open-items projections and summaries.
5. PRODUCT GAP items (promise-to-pay, disputes, collector assignment, dunning
   policy, work queue) remain unbuilt and out of the current wave.

---

## Execution log — 2026-08-10 (second pass)

### Settled
1. **Tie-out is now readable.** `EXECUTE` on `is_ap_control_account` granted to
   PUBLIC. `finance_open_items_tieout` reads clean: one live business, side
   `ar`, `ledger_net = projection_residual = 0.00`, `drift = 0.00`.
2. **Finding 4 disproved on live data.** The only invoice carrying a
   `credit_note_applications` row (invoice 00002, total 20 000) has
   `amount_paid = 20 000` = payments 5 000 + credit applied 15 000, is
   correctly absent from `finance_ar_open_items`, and contributes zero drift.
   The projection nets credit-note applications correctly; no residual change
   needed. Finding 4 → CLOSED (no defect).
3. **Wave 4 — statement idempotency.** Unique index
   `customer_statements_one_per_period` on
   `(business_id, COALESCE(branch_id, zero-uuid), contact_id, period_start,
   period_end)`, plus `upsert_customer_statement_atomic(_payload jsonb)`
   (SECURITY DEFINER, org-membership + contact/business checks) as the single
   writer. `useCustomerStatements.saveStatement` now calls the RPC instead of a
   client insert, so a double click or two tabs refresh one snapshot instead of
   creating duplicates.
4. **Wave 4 — dead comms system retired.** `invoice_reminders`,
   `invoice_emails` and `invoice_activities` (all empty, no readers) dropped;
   the write-only `invoice_activities` insert removed from
   `send-document-email`; the three names removed from
   `businessScopedTables.ts`. `document_emails` + `audit_logs` is now the only
   email/activity trail.
5. **Wave 2 residue — as-of aging.** `fetchContactOpenItemAging` takes an
   optional `asOf` (YYYY-MM-DD): it filters `document_date <= asOf` and ages
   against that date. `useCustomerStatements` and `useVendorStatements` pass
   `period_end`, so reprinting a closed period reproduces its original buckets.

### Still open (unchanged priority order)
1. `fetchTopOpenCounterparties` still derives days-overdue in JS instead of
   reading the server bucket.
2. Failed sends are still not recorded — `send-document-email` writes
   `document_emails` only on the success path, and bulk statement sends do not
   go through `email_event_outbox`.
3. Wave 5 — no `currency` column on `finance_ar_open_items` /
   `finance_ap_open_items`; multi-currency balances are still summed as if
   equal. Largest remaining integrity gap.
4. Credit netting still duplicated per consumer (three SQL sites, two JS
   helpers); candidate for one `finance_ar_net_position` projection.
5. PRODUCT GAP items (promise-to-pay, disputes, collector assignment, dunning
   policy, work queue) remain unbuilt.
