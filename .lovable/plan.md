# Trial Balance — presentation fix, posting guardrails, book corrections

## Verified state (evidence from this session)

Read from your PDF (`Run 84500156`, generated 2026-08-22 13:09 UTC):

```text
Code   Account name          Debit  Credit   Debit        Credit        Debit        Credit
```

Six money columns, no captions above them. The report foots (211,850.40 =
211,850.40 movement; 102,140.00 = 102,140.00 closing), so the ledger is not
out of balance — the columns are simply anonymous. Subtotal rows print
`KES 0.00` where detail rows print `-`.

Code check: the on-screen page (`src/pages/reports/TrialBalance.tsx`) already
declares the three bands (Account / Opening balance / Movement / Closing
balance), passes them into `toExportColumns`, applies `blankIfZero` to
subtotal and grand-total rows, and flags abnormal-side balances with `*` plus
a footnote. `ExportColumn.group` exists and the server table renderer
(`supabase/functions/_shared/pdf/components/DataTable.ts`) has a group tier.
So the app code for the band captions is present; the PDF you hold does not
show them, which means the deployed `render-report` function is behind the
code, or the server-side column spec
(`supabase/functions/_shared/reports/columnSpecs.ts` → `Opening DR`,
`Opening CR`, …) is the one that ran. That gets proven, not assumed, by
re-rendering a fresh PDF as step 1.

## Your accountant's concern, answered against market practice

Two layouts are both standard, and the difference is which one is default:

- QuickBooks / classic textbook trial balance: one Debit and one Credit column
  of closing balances as at a date.
- Odoo, Sage, SAP: Initial balance (Dr/Cr) · Period debit/credit · End balance
  (Dr/Cr) — six money columns, always under explicit band captions.

So six columns is a recognised ERP pattern, but only when captioned. An
uncaptioned `Debit Credit Debit Credit Debit Credit` header is not a layout
anyone ships. We adopt both: default to the classic two-column trial balance,
with an "Extended" mode that prints the Odoo-style captioned bands.

## Work to do

### 1. Prove the current PDF output
Re-render the Trial Balance PDF for the same period and read it. Confirm
whether band captions and `-` subtotals appear. If they do not, deploy the
`render-report` function and re-render until the printed document matches the
screen. No further presentation work is guessed at before this read.

### 2. Trial Balance layout — Simple / Extended
- Add a mode control on the report: **Simple** (default) shows Code · Account
  name · Debit · Credit, where Debit/Credit are the closing balances as at the
  period end — the format your accountant expects. **Extended** shows the
  current six columns.
- Band captions in Extended print on screen, in PDF, in XLSX and in CSV
  (`Opening balance`, `Movement`, `Closing balance`). Simple mode has one pair
  and needs no band.
- Align the server-side spec in `columnSpecs.ts` with whichever mode the export
  requests, so a scheduled or emailed trial balance is the same document.
- Keep the abnormal-balance `*` marker and its footnote in both modes.

### 3. Stop the misposting at source (bank reconciliation)
The 5,250 debit in a liability came in through the reconciliation classify
path, which accepts any GL account with no direction check:
- Rank and default the offset-account list by direction — money out favours
  expense and asset accounts, money in favours income and liability.
- Require explicit confirmation before posting a debit to a liability/equity/
  income account or a credit to an asset/expense account on a classified line.
- If the chosen offset account is the GL account of a registered bank account,
  block the classify route and direct the user to "Record a transfer"; prompt
  to register 1020 Primary Bank Account so the transfer route exists at all.
- Hint at the dedicated bank-fee field for small money-out lines.

### 4. Correct the books (approved)
Post correcting journals through the standard reversing-entry path — never a
direct write to `journal_entry_lines`:
- JE-00010: move the 250 bank service charge out of 2012 Accrued Expenses into
  the bank-charges expense account.
- JE-00011: move the 5,000 inter-account transfer out of 2012 into 1020 Primary
  Bank Account.
- Result: 2012 Accrued Expenses clears to nil; expenses rise from 1,050 to
  1,300; 1020 carries the transferred cash.
- 3900 Opening Balance Equity (100,400) is left alone — clearing a migration
  staging account is a year-end decision for you and your accountant, and no
  entry gets posted without your instruction.

### 5. Verification before this is called done
- Re-render the Trial Balance PDF in both modes and read every page: captions
  present, `-` used consistently, footnote intact.
- Confirm after the corrections: 2012 = nil, closing debits = closing credits,
  and Trial Balance closing figures tie to the Balance Sheet and P&L.
- Run the ledger reporting test suites (`src/test/architecture/ledger-reports-single-source.test.ts`
  and the reports unit tests) green.

## Technical notes

- Report: `src/pages/reports/TrialBalance.tsx`,
  `src/design-system/reports/model.ts`,
  `src/services/reports/ReportExportService.ts`,
  `supabase/functions/_shared/reports/columnSpecs.ts`,
  `supabase/functions/_shared/pdf/components/DataTable.ts`,
  `supabase/functions/_shared/exports/report{Csv,Xlsx}.ts`.
- Posting: `bank_match_confirm` (classified-movement branch),
  `src/features/finance/reconciliation/ReconcileTransactionSheet.tsx`,
  `src/hooks/useBankTransactions.ts`.
- Corrections route through the existing reversing/correcting journal path so
  `post_journal_entry_atomic` stays the only writer (ADR 0123).

## Order

1 → 2 → 3 → 4, verifying at each step.
