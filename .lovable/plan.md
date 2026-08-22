# Trial Balance — what your accountant is seeing, and why

## What the report actually says

Reading the PDF as an accountant would, the statement foots correctly
(211,850.40 = 211,850.40 movement, 102,140.00 = 102,140.00 closing), so this is
not an out-of-balance ledger. Three things are genuinely wrong, and only one of
them is a report bug — the other two are real posting problems the report is
faithfully reporting.

### 1. A liability sitting in the Debit column (real accounting error)

```text
2012  Accrued Expenses      Debit KES 5,250.00
```

A liability with a debit balance means "the supplier owes us" — which is not
what happened. Tracing it in the ledger, this balance is made up of exactly two
bank-reconciliation postings:

| Entry     | Date       | Description                            | Dr 2012 |
| --------- | ---------- | -------------------------------------- | ------- |
| JE-00010  | 2026-08-07 | Monthly bank service charge            |   250   |
| JE-00011  | 2026-08-18 | Transfer to operating expense account  | 5,000   |

Neither belongs there:

- The 250 bank charge is a **bank fee expense**. Debiting Accrued Expenses says
  a previously accrued liability was settled — but no accrual was ever raised,
  so the expense has never hit the P&L. Total expenses on the TB are 1,050
  (COGS only); the real figure is 1,300.
- The 5,000 is a **transfer between bank accounts**. It should debit account
  1020 Primary Bank Account, not a liability. As posted, cash moved out of
  1012 and vanished into a liability — and 1020 correctly shows nil.

Root cause is not the maths. In `bank_match_confirm`, a bank line classified as
`document_type = 'account'` posts to whatever GL account the user picked, with
no check on direction or account family. The picker in
`ReconcileTransactionSheet.tsx` offers income, expense, asset and liability
accounts in one flat list, unranked, so debiting a liability on a money-out line
is a single click with no warning. The transfer route was unavailable because
1020 Primary Bank Account is not registered in `bank_accounts` (only "Test
Operating Bank – KES" is), so there was nothing to transfer to.

### 2. Opening Balance Equity is still carrying 100,400

3900 Opening Balance Equity holds 50,000 (bank opening balance) + 50,400 (stock
adjustment offset). That account is a migration staging account; leaving it in
the equity section at period end is exactly what an auditor queries. It should
be cleared to Retained Earnings / Owner's Capital once migration is signed off.

### 3. The PDF drops the column-group headers (report bug)

On screen, the trial balance declares three header groups — Opening balance /
Movement / Closing balance — over the six money columns. The export path
(`toExportColumns` in `src/design-system/reports/model.ts`) has no notion of a
column group, and `ExportColumn` carries no group field, so the PDF prints six
bare columns headed `Debit Credit Debit Credit Debit Credit`. That is what makes
the PDF "look weird": the first pair is all dashes and there is nothing telling
the reader they are the opening column. Secondary to that, subtotal rows print
`KES 0.00` where detail rows print `-`, because `blankIfZero` is applied to
detail values only.

## Proposed work

### A. Fix the PDF so it reads like a trial balance

- Add an optional `group` to `ExportColumn` and carry `columnGroups` through
  `toExportColumns` / the export config, so the PDF and XLSX print the
  Opening / Movement / Closing band above the Debit-Credit pairs exactly as the
  screen does.
- Apply `blankIfZero` to subtotal and grand-total rows so an empty column reads
  as `-` throughout instead of `KES 0.00`.
- Add an "abnormal balance" marker: a liability/equity/income account with a
  debit closing balance (or an asset/expense with a credit one) gets a
  discreet flag on screen and a footnote in the PDF. A trial balance that
  silently normalises this is how the 5,250 went unnoticed.

### B. Stop the misposting at source (bank reconciliation)

- Direction-aware classification: when classifying a bank line, rank and
  default the offset account list by direction — money out suggests expense and
  asset accounts, money in suggests income and liability — and require an
  explicit confirmation before posting a debit to a liability or a credit to an
  asset on a classified line.
- Surface the transfer path properly: if the chosen offset account is the GL
  account of another registered bank account, block it and direct the user to
  "Record a transfer". Add a prompt to register 1020 Primary Bank Account as a
  bank account so transfers are possible at all.
- Bank fee: keep the dedicated fee field (it already resolves the
  `bank_fees` default account) as the recommended route for charges, and hint at
  it when a classified money-out line is under a small threshold.

### C. Correct the existing books

- Reversing/correcting journals for JE-00010 and JE-00011: move 250 to bank
  charges expense and 5,000 to 1020 Primary Bank Account, clearing 2012 to nil.
- A separate decision for you: whether to clear Opening Balance Equity to
  retained earnings now or at year end. No entry posted without your say-so.

## Technical notes

- Report: `src/pages/reports/TrialBalance.tsx`,
  `src/design-system/reports/model.ts`,
  `src/services/reports/ReportExportService.ts`, plus the mirrored server
  renderer under `supabase/functions/_shared/`.
- Posting: `bank_match_confirm` (the `ELSE` classified-movement branch),
  `src/hooks/useBankTransactions.ts`,
  `src/features/finance/reconciliation/ReconcileTransactionSheet.tsx`.
- Corrections go through the standard reversing-entry path — no direct SQL edits
  to `journal_entry_lines`.

## Order of work

A first (it is presentation only and makes the next steps visible), then B, then
C once you have confirmed the two correcting entries.
