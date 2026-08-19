# Account Register vs General Ledger — verdict and fix

## Short answer

Neither PDF is wrong in *purpose*, but the **Register export is incomplete and therefore not a defensible accounting document**. The General Ledger export is substantially correct, with one cosmetic flaw.

Your instinct is right: a register that only dispenses entries, with no balance brought forward and no balance carried forward, forces the reader to do arithmetic the ledger already knows. That is a reporting defect, not a design preference.

## What each one is supposed to be

They are genuinely different documents and should stay different.

**Account Register** — an operational, account-centric running record. Answers: *"what happened on this account, in what order, and what is the balance after each event?"* Mandatory content:
- Balance brought forward (opening) as the first line
- Every movement in date order with a running balance after each line
- Period movement totals (debits, credits)
- Balance carried forward (closing) as the last line

Debit/credit column totals are optional in a register; the **closing balance is not optional** — it is the whole point of a running record.

**General Ledger** — a formal, period-scoped statutory artifact, usually multi-account. Answers: *"for this period, per account: opening, total movement, closing — and does the whole thing balance?"* Mandatory content:
- Opening Balance line per account
- Movements
- Total Movement per account (debit/credit totals + closing balance)
- Grand total across all accounts, proving total debits = total credits

## What your two PDFs actually show

General Ledger (correct):
```
Opening Balance                                     -           -      KES 0.00
JE-00006  Payment received...            KES 1,670.40           -  KES 1,670.40
JE-00008  Payment received - INV-00002              -  KES 1,670.40     KES 0.00
Total Movement                           KES 1,670.40  KES 1,670.40     KES 0.00
GRAND TOTAL                              KES 1,670.40  KES 1,670.40            -
```
Opening stated, movement totalled, closing stated, debits = credits proven. This is right.

Account Register (incomplete):
```
JE-00006  Payment received...            KES 1,670.40      KES 0.00  KES 1,670.40
JE-00008  Payment received - INV-00002       KES 0.00  KES 1,670.40      KES 0.00
```
Two bare lines. No balance b/f, no movement totals, no balance c/f. The reader cannot tell whether the account started at zero, and cannot state the closing position without reading the last row's incidental balance and trusting it.

Worse: the on-screen register **does** show an opening-balance row and a closing-balance footer. So the exported PDF is not a faithful print of the screen — the document a user files is weaker than the one they read. That is the actual bug.

Second, smaller issue: in the GL, `GRAND TOTAL` prints `-` in the Balance column. For a single-account run that reads as "no closing balance". The grand total is a debit/credit proof, so the balance cell should either repeat the net closing balance or be visually suppressed rather than showing a dash that looks like missing data.

## Verdict

- Register PDF: **defective** — missing opening, movement totals, and closing; diverges from its own screen.
- GL PDF: **correct**, one cosmetic ambiguity in the grand-total balance cell.
- Should they differ? **Yes.** Register = chronological running record for one account (all detail, running balance, drill-down). GL = period statement for one or many accounts (opening / movement / closing per account, plus a balancing proof). Neither should be collapsed into the other.

## Changes to make

1. `src/pages/finance/AccountRegister.tsx` — `getExportConfig`:
   - Prepend a **Balance brought forward** row using `accountData.opening_balance` (blank debit/credit, balance filled), so the export matches the on-screen opening row.
   - Append a **Total movement for period** row (sum of debit and credit columns over the full-period transactions, not the search-filtered subset).
   - Append a **Balance carried forward** row using `accountData.closing_balance`.
   - Mark these rows with the statement line-kind contract (`_kind`: `note`/`major_total`/`grand_total` as appropriate) so the PDF engine gives them total typography instead of styling them as detail lines.
   - When a search filter is active, keep the b/f and c/f figures period-true and label the export as filtered, so a partial view can never be mistaken for the full ledger.

2. `src/pages/reports/GeneralLedger.tsx` — grand-total row: stop emitting a dash in the Balance column; leave it genuinely empty (or carry the net) so it does not read as missing data.

3. No database or RPC changes. `useGeneralLedger` already returns `opening_balance`, `closing_balance` and per-line `running_balance` in natural sign; this is purely a presentation/export gap.

## Technical notes

- Register totals must be derived from `accountData.transactions` (full period), never from `transactionsWithBalance` (search-filtered), preserving the existing rule that a running balance is a ledger property, not a view property.
- Export rows go through `ReportExportService` → `render-report`; total rows need `_kind` from `src/design-system/reports/statementKinds.ts` to render with rule lines.
- After changing anything under `supabase/functions/_shared/pdf` or `_shared/reports`, redeploy `render-report` and `process-scheduled-reports` and bump `v` in `src/services/reports/pdfCache.ts`. The changes above are page-level, so that should not be needed.
