# Un-reconcile: fix the real failure, then make it feel like a real ledger

## What actually went wrong (confirmed in the database, not guessed)

The refusal you saw is **not** a policy telling you to go and void the journal entry.
It is an internal defect in the void engine, and it fires for *every* void that
goes through `void_journal_entry_atomic`.

Traced end to end for your 50,000 line (Joshua Holdings, `JE-00009`,
"Opening balance", classified to an account):

1. `unreconcile_bank_transaction` correctly takes the "classified movement"
   branch and calls `void_journal_entry_atomic` — it never tries to edit the
   posted entry itself. That part of the design is sound.
2. `void_journal_entry_atomic` inserts the reversing entry **already stamped
   `status = 'posted'`**, and only then inserts its mirrored lines.
3. Inserting those lines fires `trg_jel_recompute_je_totals`
   (`_recompute_je_totals`), which runs `UPDATE journal_entries SET total_debit,
   total_credit` on that brand-new, already-posted reversal.
4. The immutability trigger sees a posted row being updated with no status
   change and raises exactly the message you got:
   *"Cannot modify a posted journal entry. Create a reversing entry or void it instead."*

The posting engine `post_journal_entry_atomic` avoids this by setting
`app.suppress_je_recompute = 'on'` for the duration of the insert. The void
engine never does. That single missing guard is the whole bug.

Consequence: the message is misleading advice about a defect, not a rule. No
amount of "go void it in the journal" would have worked either — voiding that
entry from the journal page calls the same function.

## The fix

### 1. Repair the void engine (root cause)

Migration on `public.void_journal_entry_atomic`:

- Wrap the reversal header + line inserts in `set_config('app.suppress_je_recompute','on',true)`,
  then stamp `total_debit` / `total_credit` on the reversal from the summed lines
  in the same statement that clears the flag — the same shape the posting engine
  already uses.
- Leave every existing refusal (already-voided, is-a-reversal, period lock,
  authorisation) untouched.

This restores voiding everywhere it is used: bank un-match, payment reversal,
bill payment reversal, journal voucher void.

### 2. Teach the pre-flight about it

`bank_unmatch_preflight` currently answers "allowed" for this line, because it
mirrors the *declared* refusals only. After the engine repair the answer is
correct as-is; no widening needed. Add a regression test that the 50,000-style
line (classified to an account, opening-balance dated) is reported
`allowed = true, requires = 'void_journal_entry'` **and** that the mutating RPC
then actually succeeds.

### 3. Make the act visible while it runs (your first concern)

In `src/pages/BankReconciliation.tsx`:

- The confirm button enters a pending state (`Reversing…`, spinner, disabled)
  from click until the RPC resolves, and the dialog cannot be dismissed while
  pending — so a second click is impossible, not merely discouraged.
- The mutation is keyed so a duplicate submission is dropped client-side too.
- On success: a toast naming the consequence ("Match reversed. Journal entry
  JE-00009 voided by reversal JE-00009-REV").
- On refusal: the mapped accountant sentence, never the raw `P0001`.

### 4. Where the voiding happens (your second concern)

**Answer from how the major ledgers do it:** none of them make you leave the
reconciliation screen.

| System | Un-match behaviour |
| --- | --- |
| Xero | "Remove & Redo" / "Undo" on the bank line, right in the reconciliation tab. The posting it created is reversed by the same click. |
| QuickBooks Online | "Undo" on the matched line in the Banking feed; "Undo reconciliation" for a whole period. Never sends you to the journal. |
| NetSuite | "Unmatch" in the Match Bank Data page; the system reverses the generated payment/deposit itself. |
| Dynamics 365 BC | "Remove match" on the Bank Rec. worksheet; posted reversals go through a dedicated reversal, still initiated from the worksheet. |
| SAP S/4HANA | Reset clearing (FBRA) is a distinct transaction, but it is invoked *from* the reconciliation item, and the reversal document is created automatically. |

The common rule, and the one this app already follows on paper (ADR-0149):
**un-matching is initiated where the match lives; if the match created a
posting, the same act reverses that posting automatically, by reversal entry,
never by editing or by asking the user to do it elsewhere.** Manual navigation
to the journal is only for entries that were never created by a match.

So: no ping-pong. Once the engine defect above is fixed, the existing single
"Unreconcile" button is the correct interaction — it will void the entry itself.
The remaining work is presentational: the dialog states, up front, what will be
voided ("This will reverse journal entry JE-00009 with a dated reversing entry
on 31 Jul 2026"), which the pre-flight already returns, and afterwards offers a
link to the reversal for audit — a destination, not a chore.

### 5. Your 50,000 residual

With the engine fixed, un-matching that line voids the duplicated opening-balance
posting and the −50,000 residual on the reconciliation report resolves itself.
The duplicate-opening-balance trigger added earlier keeps it from recurring.

## Technical detail

- Migration: `void_journal_entry_atomic` — suppress the line-level recompute and
  set the reversal totals explicitly (mirrors `post_journal_entry_atomic`).
- Guard: `supabase/tests/journal_void_recompute_invariants_test.sql` — voiding a
  posted multi-line entry succeeds and the reversal's totals equal its line sums.
- UI: `src/pages/BankReconciliation.tsx` (pending state, consequence sentence,
  post-void link), `src/hooks/useBankTransactions.ts` (surface the reversal id).
- ADR-0149 gains a short addendum recording that "un-match reverses in place" is
  the industry norm and the defect that made it look like a policy.
