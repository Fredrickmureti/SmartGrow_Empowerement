# Wave: Payment / Settlement Engine

Status: COMPLETE — settlement fixed and verified end to end against the
Microfinance database (Supabase ref `xwxqunklduknceoryrha`, business
`cbc73525-f93c-4d79-9f9a-8d04e12c4f56`). No AccrualFlow database was touched.

## Verdict

```text
Current Architecture: CORRECT AND REUSABLE (no rewrite, no new tables)
Settlement:           FIXED
Individual Payments:  PASS
Group Collection:     PASS
Allocation:           PASS
Arrears:              PASS
Loan Balance:         PASS
Accounting:           PASS
Reversal:             PASS
Idempotency:          PASS
Receipt:              PASS (existing document engine, company data from settings)
Reporting:            PASS
Permissions:          PASS (server-side refusal proven)
```

## Root cause

Recording a payment failed in the accounting step, not the payment step.
The journal status list allows only `draft | posted | void`, but the finance
routine `post_journal_entry_atomic` (18-arg) compared against `'voided'`,
which does not exist — Postgres rejected the statement with
`invalid input value for enum journal_status: "voided"` (22P02). Payment,
allocation and posting share one transaction, so the whole payment rolled
back. This affected every lending posting: individual payment, group sheet,
disbursement and write-off.

A second defect surfaced during reversal testing: the voiding routine created
its correcting entry in a way the "posted entries cannot change" rule
rejected.

Two front-end defects explained the visible symptoms: the toast printed
`[object Object]` (the formatter only read `Error` objects, not Supabase's
plain error object), and the dialog awaited the save without catching, giving
the "Uncaught (in promise)" console entry.

## Changes made

Database (migrations):
- `post_journal_entry_atomic` (18-arg): idempotency guard compares against the
  valid `void` value.
- `void_invoice_atomic`: same stale-wording correction.
- Journal voiding path: correcting entry now created in a way the immutability
  rule accepts.
No table, column, enum, policy or RPC signature changes.

Front end:
- `friendly()` in `src/hooks/useMfRepayments.ts` — reads the message from
  Supabase-style error objects, so refusals appear in plain language.
- `submit()` in `src/apps/lending/repayments/RecordPaymentDialog.tsx` — catches
  the refusal so nothing lands unhandled in the console and the dialog keeps
  the captured values.

## Tests executed (real data, this database)

| Case | Data | Result |
| --- | --- | --- |
| A Exact installment | LN-000001, RCP-202608-00002 KES 5,480 | PASS |
| B Partial | LN-000001, RCP-202608-00001 KES 2,000 | PASS |
| C Overpayment | LN-000005, RCP-202608-00004 KES 21,000 → loan closed | PASS |
| D Multi-installment | LN-000001, RCP-202608-00003 KES 24,960 | PASS |
| E Arrears | LN-000006, RCP-202608-00005 KES 10,600 | PASS |
| F Group collection | Group 70b8b0fb…, LN-000003/4/5, RCT-G1/G2/G3 — each receipt settled only its own member's loan | PASS |
| G Duplicate reference | second `DUPTEST-1` refused | PASS |
| H Reversal | RCP-202609-00008/00009 — original preserved, journal marked `void`, balanced mirrored correcting entry (JE-00025 500/500) | PASS |

Derived state confirmed from the authoritative views:
- `mf_loan_balances`: LN-000001 contractual 49,920 − posted 39,520 = 10,400
  outstanding; LN-000006 31,800 − 10,600 = 21,200 with 5,300 overdue / 31 DPD.
  Reversed receipts are excluded everywhere.
- `mf_loan_installment_status`, `mf_loan_arrears` derive from obligations minus
  settlements — no flag is set by hand.
- `mf_event_postings` → `journal_entries`: every repayment has one balanced
  entry (Dr Cash 1111 / Cr Interest Income 4310 / Cr Loan Principal Receivable
  1370). No duplicate postings.
- Reporting: `mf_collections_by_officer`, `mf_collections_by_branch`,
  `mf_client_statement` all show the settled payments and exclude reversals.
- Receipt: `loan_payment_receipt` builds through the existing document engine
  and pulls institution details from `businesses` — nothing hardcoded.
- Permissions: calling `mf_reverse_repayment` without an authenticated actor is
  refused server-side ("You do not have permission to reverse a receipt").

## Known leftovers / risks

- Test receipt `RCP-202609-00007` (KES 2,080 on LN-000001) is still posted.
  It cannot be reversed from an unauthenticated SQL session by design; reverse
  it from the Repayments screen while signed in as the test administrator if
  clean test data is wanted.
- Pre-fix reversal entry JE-00023 has correct lines (500/500) but zero header
  totals. Historical artefact of the old defect only; entries created after the
  fix (JE-00025) carry correct totals.
- The stale `'voided'` wording still exists in sales/POS routines
  (`get_sales_dashboard_kpis`, `preview_reversal_consequences_core`,
  `apply_customer_deposit_atomic`, others). Those compare text columns, not the
  journal status list, so they do not break lending. Future cleanup item.

## Future cleanup (not this wave)

- Remove orphaned AccrualFlow ERP tables (inventory, sales, POS, procurement).
- Audit the remaining `'voided'` string comparisons across finance routines.
- Backfill header totals on JE-00023.

## Next wave

Lending arrears/PAR ageing and collection-sheet reporting hardening, or the
ERP orphan cleanup — whichever the client prioritises.
