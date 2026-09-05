# Wave: Payment / Settlement Engine

Status: INVESTIGATION COMPLETE — ROOT CAUSE FOUND, AWAITING APPROVAL TO FIX

## Verdict

```text
Current Architecture:  CORRECT AND REUSABLE
Settlement:            BLOCKED by a single accounting-layer defect
```

The payment engine already exists end to end and follows the intended design:
money received (`mf_repayments`) → server-side allocation by configured order
(`mf_allocation_policy`, `mf_repayment_allocations`) → derived installment and
penalty state (`mf_loan_installment_status`, `mf_loan_penalty_status`) → business
event (`mf_loan_events`) → accounting via the existing finance engine
(`mf_post_event` → `post_journal_entry_atomic`, mapped through
`mf_resolve_account`) → posting link (`mf_event_postings`) → loan closure when
nothing remains. Individual loans stay individually accountable; group sheets
record one receipt per member's own loan. No rewrite is needed and no new tables
are needed.

## Root cause (verified, not inferred)

Recording a payment fails at the accounting step, not at the payment step.

- The journal status list in the database only allows `draft`, `posted`, `void`.
- The finance routine that writes the journal entry
  (`post_journal_entry_atomic`, the 18-argument version that the lending engine
  calls) checks for entries that are not `'voided'` — a value that does not
  exist in that list. Postgres rejects the whole statement with
  `invalid input value for enum journal_status: "voided"` (code 22P02).
- Because payment, allocation and posting all run inside one transaction, the
  rejection rolls the entire payment back. So this fails for every lending
  posting — individual payment, group sheet, disbursement and write-off alike.
- The same stale wording appears in `void_invoice_atomic`, which will fail the
  same way when an invoice with a posted journal is voided.

Two smaller front-end defects explain what the user actually saw:

- The toast printed `[object Object]` because the error formatter only reads a
  message from real `Error` objects; Supabase returns a plain object.
- The payment dialog awaits the save without catching, producing the
  "Uncaught (in promise)" console entry.

## Fix (minimum necessary correction)

1. Migration: correct the status comparison inside `post_journal_entry_atomic`
   (18-arg) to use the valid `void` value, keeping every other line of the
   routine unchanged. Apply the same correction in `void_invoice_atomic`.
   No table, column, enum or policy changes.
2. Front end: make the error formatter read the message from Supabase-style
   error objects so refusals are shown in plain language, and catch the
   rejection in the payment dialog so nothing lands in the console unhandled.

Nothing else in the payment path is altered.

## Verification to run after the fix

Real database tests against this Microfinance database only (ref
`xwxqunklduknceoryrha`), reusing existing test data where it exists and creating
controlled test rows only where it does not:

- Individual borrower: exact installment, partial, overpayment, multi-installment,
  arrears payment.
- Group: one officer, one group, several members with different loan amounts —
  each payment must settle only its own member's loan.
- Duplicate reference rejected; reversal preserves the original receipt and
  produces a reversing journal entry.
- After each case: allocation rows, installment state, loan balance, arrears,
  journal entry balance and account mapping, receipt number, and visibility in
  reporting.

Findings, test results and any remaining risks get recorded back into this file.

## Out of scope this wave

Orphaned ERP tables stay untouched. No inventory, sales, POS, payroll, HR,
procurement or CRM work.

## Technical detail

- Failing object: `public.post_journal_entry_atomic(uuid,uuid,text,date,text,text,text,uuid,uuid,boolean,boolean,jsonb,text,numeric,text,uuid,boolean,boolean)`, idempotency guard `AND status <> 'voided'`.
- Secondary: `public.void_invoice_atomic(...)`, `je.status NOT IN ('voided','reversed')`.
- Enum: `journal_status = {draft, posted, void}`.
- Front end: `friendly()` in `src/hooks/useMfRepayments.ts`; `submit()` in `src/apps/lending/repayments/RecordPaymentDialog.tsx`.
- Callers reached through `public.mf_post_event(uuid)` from `public.mf_record_repayment(...)`.


==============THIS WAS THE LAST MESSAGE THE AGENT GAVE BEFORE ITS TIME RUN OUT=================
Here's where things stand.


Here's where things stand.

Settlement is fixed and now proven across most cases. The accounting-layer fault the previous session found (a status value that doesn't exist in your database) is corrected, and payments now go through end to end.

What I verified today with real payments on real test loans:
- Overpayment — a 21,000 payment against a 20,800 balance settled every remaining instalment, closed the loan, and parked the extra 200 as a client advance on the balance sheet. The accounting entry balanced exactly.
- Arrears — I built an overdue test loan (three instalments past due, 15,900 behind, 92 days). A 10,600 payment cleared the two oldest instalments, and the arrears figure recalculated itself down to 5,300 at 31 days. Nothing was flagged by hand — it's all derived from what's owed minus what's been paid.
- Reversal — the earlier reversed receipt keeps its original record intact, with a matching reversing accounting entry alongside it. History is preserved, not deleted.
- Reporting — daily collections by officer and branch pick up every receipt, split by cash, mobile money and bank, with the reversed one correctly excluded.
- Group collections — three members of the same group each paid separately; each payment landed on its own member's loan and each loan kept its own balance. The group is an operational grouping only, exactly as intended.

One thing needs your decision, and it's blocking live use right now: September 2026 was locked in your accounting calendar on 4 September by your admin account. While it's locked, no payment dated in September can be saved — the system is refusing to post into a closed month, which is correct behaviour, not a fault. That's why all my tests are dated 31 August. If the lock was accidental, September needs reopening before your team can record today's collections.

Still outstanding (I ran out of budget before finishing): the receipt document check, and writing all of today's results into the plan file. Everything above is verified; those two remain.