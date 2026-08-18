# ADR 0144 — Bank reconciliation is one matching seam

Status: Accepted
Date: 2026-08-18
Related: ADR-0123 (single journal posting monopoly), ADR-0136 (one FX engine; a
missing rate is an absence), ADR-0141 (a bank balance is derived, never stored),
ADR-0143 (a bank feed is transport)

## Context

Matching a bank line to a document is the point where an operational record turns
into an accounting fact. Before this wave the act was spread across client code
and several half-engines: a browser could mark a `bank_transaction` reconciled,
settlement could be written without touching invoice or bill allocations, a bank
charge could be absorbed into the document amount, and split lines lived in a
separate `bank_transaction_splits` table that nothing reconciled against.

That made a reconciliation unfalsifiable in exactly the way a balance was: the
"reconciled" flag was a client assertion, not the by-product of a posting.

## Decision

1. **Four seams, no fifth path.** `bank_match_propose`, `bank_match_confirm`,
   `bank_match_reject`, `bank_match_reverse`. All SECURITY DEFINER with a pinned
   `search_path`, none executable by `anon`. Application code never writes
   `bank_reconciliation_matches` or the reconciled state on `bank_transactions`.
2. **Propose is a proposal.** Proposing carries no accounting consequence and
   posts nothing. Only `confirm` settles, and only `reverse` undoes it — there is
   no delete of a confirmed match.
3. **n:m allocations are the representation.** One bank line may settle several
   documents and one document may be settled by several lines. Partial
   settlement is the normal case, and a "split" is allocations on this seam —
   which is why `bank_transaction_splits` was dropped rather than reconciled.
4. **No minting.** Settlement is delegated to the existing payment engines
   (`record_multi_invoice_payment` / `record_multi_bill_payment`); the matching
   seam never posts a payment itself and never writes a journal line except
   through `post_journal_entry_atomic`.
5. **The residual is named.** A difference between the bank line and the
   documents it settles is either a bank charge posted to the canonical default
   account, or an explicit write-off — never a silent adjustment of the document.
6. **FX refuses rather than guesses.** A cross-currency match requires a rate
   from the one resolver (`require_exchange_rate`); when the rate is absent the
   match is refused. An absence is not a 1.0.

## Consequences

- "Reconciled" is a consequence of a posting, reproducible from the allocations
  and the journal, and reversible only through a seam that unwinds both.
- Reconciliation reports read one shape (`bank_reconciliation_sessions` plus the
  matches), so the session report and the account position cannot disagree.

## Enforcement

- `supabase/tests/bank_matching_seam_invariants_test.sql`,
  `supabase/tests/bank_reconciliation_lifecycle_invariants_test.sql`.
- `src/test/architecture/banking-reconciliation-seam.test.ts`,
  `src/test/architecture/banking-write-seam.test.ts`.
