# Fix: reference drawer shows KES 0.00 for the bank-deposit journal entry

## What is actually happening

The Undeposited Funds register row for the reconciliation entry is JE-00008,
whose `source_type` is `bank_reconciliation` and whose `source_id` is the bank
transaction. Clicking the reference opens `TransactionPreviewDrawer` with that
pair (`src/pages/finance/AccountRegister.tsx:378-386`).

Inside the drawer's resolver:

- the explicit list of journal-only source types (line 635-649) contains
  `bank_recon`, **not** `bank_reconciliation`, so this entry falls through to the
  `default` branch (line 676);
- both that generic branch and the `default` branch return a hardcoded
  `amount: 0` (lines 664 and 692) because they `select("*")` from
  `journal_entries` only — they never read the entry's lines, and
  `journal_entries` carries no amount the drawer reads.

So the 0.00 is a display defect in the drawer's fallback path, not an accounting
problem: the entry itself is Dr 1012 Cash at Bank 1,670.40 / Cr 1340 Undeposited
Funds 1,670.40 and the account nets to zero as it should.

This affects every source type that lands in those two branches (year-end
closing, POS sale, stock adjustment, depreciation, transfers, …), all of which
show 0.00 today. The `journal_entry` case already does it correctly by summing
debits (line 525, 542).

## The change

Frontend only, one file: `src/components/finance/TransactionPreviewDrawer.tsx`.

1. Select the entry's lines in the generic and default branches, the same shape
   the `journal_entry` case already uses
   (`journal_entry_lines(debit, credit, description, accounts(code, name))`),
   and set `amount` to the summed debits — the entry total for a balanced entry.
2. Add a short line summary as the drawer subtitle (falling back to the
   reference/description) so the drawer names the two accounts moved, e.g.
   "1012 Cash at Bank - KES • 1340 Undeposited Funds".
3. Register `bank_reconciliation` as a known source type: add it to
   `SOURCE_LABELS` as "Bank Deposit / Reconciliation" and to the journal-only
   case list next to `bank_recon`, so it is a recognised path rather than the
   unknown-type fallback (which currently also logs a console warning).
4. Order the lookup by `created_at` and take the first row instead of
   `maybeSingle()` on the `source_type`/`source_id` pair, so a source that ever
   produced more than one entry renders instead of erroring.

No change to the ledger, the reconciliation seam, or any RPC.

## Verification

Open the Undeposited Funds register, click the reference on the reconciliation
row, and confirm the drawer reads KES 1,670.40, titled as a bank deposit, with
both account names in the subtitle; then repeat on a manual JE row to confirm
the existing `journal_entry` path is unchanged.
