# Settlement & Posting Convergence — Audit Verdict and Remediation

## Verdict

The platform is **much closer to canonical than a greenfield audit would
assume, but the "one posting engine" claim in `docs/audit/finance-verdict.md`
is no longer true.** AR and AP each have a single canonical settlement writer
(ADR 0027 / 0028 landed; the AP legacy-column ratchet is already at zero).
What has drifted is the layer *below* settlement: journal posting. And one
module — Banking/Reconciliation — has grown into a second AR settlement
engine.

Nothing below is inferred. Each item was confirmed by reading the live
database function bodies or the source file.

## Confirmed findings

**F1 — 18 database functions raw-insert into `journal_entries` instead of
calling `post_journal_entry_atomic`.** Verified by querying `pg_proc` bodies.
Only `post_journal_entry_atomic` is supposed to. Offenders include
`record_multi_bill_payment` (the canonical AP settlement writer),
`apply_credit_to_invoice_atomic`, `confirm_bill_atomic`,
`confirm_vendor_credit_note_atomic`, `finance_post_gr_journal`,
`post_stock_adjustment_gl`, `record_opening_stock`,
`physical_count_supersede`, `payroll_generate_reclassification_je`,
`revalue_fx_balances`, `create_gl_entry_from_source`,
`reconcile_bank_transaction_atomic`, `reconcile_bank_transfer_atomic`.
(`create_journal_entry_atomic` = draft lifecycle and
`void_journal_entry_atomic` = reversal are legitimate exceptions.)
Consequence: journal-book assignment, narration convention (ADR 0020),
scope stamping and integrity hooks live in the canonical RPC and are
re-implemented — or silently skipped — sixteen times.

**F2 — Reconciliation is a second AR settlement engine.**
`reconcile_bank_transaction_atomic` both `INSERT`s into `payments` and
raw-inserts a journal entry. Bank matching can therefore *create* settlement
rather than *validate* it, which is the exact inversion the canonical model
forbids.

**F3 — The M-Pesa C2B webhook writes to a table that does not exist.**
`supabase/functions/mpesa-c2b/index.ts:349` inserts a bare `payments` row
(no `payment_allocations`, no `business_id`, no journal entry), then inserts
into `invoice_payments` — confirmed absent from the schema. Inbound mobile
money silently produces an unallocated, unposted payment.

**F4 — An edge function posts journals with the service-role client.**
`supabase/functions/post-loan-interest-accrual/index.ts:85-125` inserts the
header, then the lines, then hand-rolls a `DELETE` as compensation if the
lines fail. Non-atomic, and outside every rail the canonical RPC provides.

**F5 — Expense GL is composed client-side.** `useGLPosting.ts` builds
expense journal lines in the browser; `useExpenses.ts` and
`useExpensesPaginated.ts` are two live writers of the same `expenses`
aggregate.

**F6 — A client-side importer writes settlement directly.**
`src/components/migration/steps/MigrationStepPayments.tsx:148-180` inserts
`payments` and `payment_allocations` from the browser, bypassing the engine
and its invariants.

**F7 — POS keeps its own settlement substrate, and can double-represent
cash.** Tenders live in `pos_transaction_payments`; `process_pos_transaction`
and `process_pos_return` post no GL (deferred to statement/shift close, which
*does* use the canonical RPC). When a POS sale is invoiced,
`usePOSInvoiceRequest.ts` re-records each tender through
`record_payment_atomic`, so the same cash event exists in two substrates,
guarded only by a posting gate.

**F8 — Legacy writers still resolvable.** `record_bill_payment_atomic` and
`record_payment_atomic` remain callable alongside their canonical
multi-document successors. `employee_advances` posts no GL at all while
`employee_loans` posts canonically — asymmetric treatment of the same
employee-receivable concept.

## Target architecture

```text
business module (Sales / Purchases / Payroll / POS / Banking UI)
        |  initiates a settlement intent
        v
one settlement engine per ledger side (AR / AP / Payroll)
        |  emits an accounting event
        v
post_journal_entry_atomic          <- the ONLY writer of journal_entries
        v
General Ledger  --projection-->  balances, aging, statements, reports
        ^
        |  validates, never creates
reconciliation engine
```

## Phases

**Phase 1 — Lock the posting monopoly.**
Add a DB-level guard so `journal_entries` can only be inserted by
`post_journal_entry_atomic` (a session-token pattern identical to the
existing `_pos_set_writer_token` approach), plus a SQL self-test in
`supabase/tests/` that fails when any function outside the allowlisted three
raw-inserts into `journal_entries`. This makes every later phase
non-regressible.

**Phase 2 — Convert the sixteen offenders.**
Rewrite each raw-insert function to build its lines and call
`post_journal_entry_atomic`. Ordered by financial risk: settlement writers
(`record_multi_bill_payment`, `apply_credit_to_invoice_atomic`,
`confirm_bill_atomic`, `confirm_vendor_credit_note_atomic`) first, then
inventory/valuation posters, then period-end (`revalue_fx_balances`) and
migration helpers. No change to the resulting entries beyond gaining
journal-book assignment and narration compliance.

**Phase 3 — Demote reconciliation to a validator.**
Split `reconcile_bank_transaction_atomic`: matching and linking stay; the
payment-creating branch is removed and replaced by a call into the canonical
AR settlement engine (`record_multi_invoice_payment`) when the operator
chooses "create payment from statement line". Reconciliation then only links
existing settlement to bank lines and asserts the JE is posted.

**Phase 4 — Close the ingress leaks.**
Rewrite `mpesa-c2b` to call `record_multi_invoice_payment` and drop the
phantom `invoice_payments` write; rewrite `post-loan-interest-accrual` to
call `post_journal_entry_atomic`; move `MigrationStepPayments` onto the
engine behind a server function; collapse `useExpenses` /
`useExpensesPaginated` into one writer and move expense line composition out
of `useGLPosting` into a DB function.

**Phase 5 — POS boundary.**
Keep the deferred-posting retail model (it is correct and matches SAP and
Odoo retail), but stop the POS→invoice bridge from re-recording tenders. The
invoice settlement becomes a projection of the committed POS tenders through
one server-side path, so a POS cash event has exactly one settlement
representation.

**Phase 6 — Retire the legacy surface.**
Drop `record_bill_payment_atomic` and `record_payment_atomic` once Phase 5
removes the last caller. Give `employee_advances` the same
event-emits / Finance-posts treatment as `employee_loans` (ADR 0091).

**Phase 7 — Record the architecture.**
New ADR "single journal posting monopoly", superseding the finance-verdict
claim; an audit doc with before/after offender counts; refreshed `mem://`
core rules so future work cannot reintroduce a second poster.

## Technical notes

- Every Phase 2 conversion is a Supabase migration. Existing posted entries
  are untouched — no backfill, no re-posting.
- The Phase 1 guard whitelists exactly `post_journal_entry_atomic`,
  `create_journal_entry_atomic` (drafts) and `void_journal_entry_atomic`.
- Architecture guards sit alongside the existing ratchet tests
  (`payment-allocations-first-class.test.ts`,
  `bill-payment-allocations-first-class.test.ts`) so the pattern is familiar.
- Phase 4's `mpesa-c2b` change is the only user-visible behaviour fix in the
  programme: inbound C2B payments will start allocating and posting.