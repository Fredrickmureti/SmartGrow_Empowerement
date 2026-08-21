# ADR 0149 — Un-matching a posted bank line is a refusable, pre-announced act

Status: Accepted
Date: 2026-08-21
Related: ADR-0123 (single journal posting monopoly), ADR-0141 (a bank balance is
derived, never stored), ADR-0144 (bank reconciliation is one matching seam),
ADR-0147 (reconciliation resolution kinds)

## Context

`unreconcile_bank_transaction` already unwinds a confirmed match correctly: it
voids the settlement payment or the classified movement through
`void_journal_entry_atomic`, never by editing a posted entry. The defect was not
the accounting — it was that the workspace only learned an un-match was illegal
by attempting it and reading a raw `P0001`. A locked period, a missing payment
record or an entry that is itself a reversal all surfaced as the same dead-end.

Separately, the reconciliation report could *name* a cause of a residual (most
visibly a duplicate opening balance) but offered nowhere to go and no statement
of what the correct cure is.

## Decision

1. **Un-match ≠ un-post, but it may cause a posting to be voided.** Breaking a
   link that never posted anything is metadata. Breaking a link whose
   confirmation *created* a posting reverses that posting, by void only. This
   matches the majority ledger convention (Dynamics, Oracle, NetSuite, SAP,
   Xero): reversal is explicit and auditable, never silent.
2. **Refusals are declared before the click.** `bank_unmatch_preflight` is a
   read-only mirror of the refusal conditions inside
   `unreconcile_bank_transaction`: permission, already-unreconciled, closed
   period, missing settlement record, entry-is-a-reversal. It returns a stable
   code plus a sentence written for an accountant, and it announces the
   consequence (`void_payment` / `void_journal_entry` / `link_only`).
3. **The pre-flight authorises nothing.** The mutating RPC re-checks every
   condition. A stale "allowed" answer can only lead to the same refusal, never
   to an unguarded write.
4. **An opening balance may be posted once.** A trigger on
   `bank_reconciliation_matches` refuses to confirm a classification of a
   statement line to the bank's own control account on or before the account's
   opening-balance date when an opening-balance entry already exists. The known
   defect becomes impossible to re-create rather than merely reported.
5. **Findings carry a remedy, not a fix.** The residual explainer maps each
   engine code to wording and a destination
   (`src/features/finance/reconciliation/residualRemedies.ts`). It contains no
   arithmetic and no writes; the cure is always performed by the owning seam.

## Consequences

- The workspace can grey out and explain an impossible un-match instead of
  failing at the database.
- Duplicate opening balances are prevented at the point of confirmation, so the
  residual explainer's `duplicate_opening_balance` finding becomes a historical
  clean-up rather than a recurring class.
- Remedy wording lives in one table, so the report, the workspace and any future
  surface phrase the same finding identically.

## Addendum (2026-08-21) — the refusal that was a defect

An un-match of a classified statement line failed with
`Cannot modify a posted journal entry. Create a reversing entry or void it
instead.` That message read as a policy ("go to the journal and void it there"),
but it was a defect in the void engine and it affected **every** caller of
`void_journal_entry_atomic`.

`void_journal_entry_atomic` inserted the reversal header already stamped
`status = 'posted'` and only then wrote its lines. Each line insert fired
`trg_jel_recompute_je_totals`, which UPDATEs `journal_entries.total_debit /
total_credit` — an update of a posted row, refused by the immutability trigger.
`post_journal_entry_atomic` never hit this because it sets
`app.suppress_je_recompute = 'on'` and stamps the totals on the header itself.
The void engine now does the same.

This also settles the workflow question the failure raised: un-matching is
initiated where the match lives, and when the match created a posting the same
act voids it by a dated reversing entry. That is the majority convention (Xero
"Remove & Redo", QuickBooks "Undo", NetSuite "Unmatch", Dynamics 365 BC "Remove
match", SAP reset-clearing from the reconciliation item). Sending an accountant
to the journal page is never the cure for a posting the reconciliation created.

A second defect sat immediately behind it: after reversing correctly, the RPC
released the line with `match_source = 'unreconciled'`. `match_source` records
*how* a line was matched (`manual | rule | ai`); it is not a lifecycle field,
and the CHECK constraint rejected the token, aborting the whole transaction at
the last statement. A line with no match has no match source, so it is now
cleared to NULL — the lifecycle is carried, as it always was, by
`is_reconciled = false` and `lifecycle_status = 'for_review'`.

## Enforcement

- `supabase/tests/bank_unmatch_preflight_invariants_test.sql`
- `supabase/tests/journal_void_recompute_invariants_test.sql`
- `supabase/tests/bank_match_source_vocabulary_test.sql`

- `src/test/architecture/banking-unmatch-preflight.test.ts`

