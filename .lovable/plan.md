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

Here's where things stand on the payment and settlement work.

Verified working (real data, September 2026): a KES 2,080 payment on loan LN-000001 recorded cleanly — receipt RCP-202609-00007, allocation of KES 480 interest and KES 1,600 principal, loan balance dropped to KES 10,400 with no arrears, and a balanced journal entry (JE-00021: cash in KES 2,080, interest income KES 480, loan principal KES 1,600). I also generated the printable payment receipt PDF end to end for that payment — it produced a valid document.

Fixed in the app: payment errors now show a readable message instead of "[object Object]", including a clear hint when a month is closed, and a failed save keeps the form open instead of throwing an invisible error.

Still outstanding: the invoice-void and payment-void routines (and two reporting helpers) still compare a journal's state against an old value that no longer exists, which will fail if someone voids an invoice or a payment. That needs a database correction, which I hadn't submitted yet. The plan file also still needs the verified results written into it.