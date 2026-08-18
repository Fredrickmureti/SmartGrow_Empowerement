# ADR 0145 — A bank account is a server-owned identity with a lifecycle

- **Status**: Accepted (2026-08-18, Banking domain reconstruction, Wave 3)
- **Related**: ADR-0123 (single journal posting monopoly), ADR-0141 (a bank
  balance is derived, never stored), ADR-0143 (a bank feed is transport),
  ADR-0136 (one FX engine; a missing rate is an absence)

## Context

ADRs 0141 and 0143 recorded what a bank account is *not* (a place to cache a
balance, a place to keep feed state). Nothing recorded what it *is*, even though
the account row is the anchor for every other banking invariant: ingestion
refuses a non-active account, reconciliation resolves its permission and fiscal
gates from the account, matching refuses an account with no GL link, and the
position projection reads its opening balance.

Before this wave, the browser inserted and updated `bank_accounts` directly. A
client could therefore create an account that was simultaneously "active" and
unmapped to the general ledger, edit the currency of an account that already had
posted history, change `business_id` after the fact, or delete an account whose
statements and journal entries were already in the ledger. Each of those is a
silent corruption of a downstream engine's precondition, discovered months later
as an unexplainable trial balance.

## Decision

1. **Identity is created and mutated only through seams.**
   `bank_account_create`, `bank_account_update`, `bank_account_transition`,
   `bank_account_delete_draft` and `bank_account_reset_opening_balances` are
   `SECURITY DEFINER` with a pinned `search_path`; `authenticated` holds `SELECT`
   only on `bank_accounts`, and `anon` holds nothing.
2. **The lifecycle is an explicit enum, not a boolean.**
   `bank_account_lifecycle_status` is `draft | active | suspended | closed`.
   Only `bank_account_transition` moves an account between states, and it refuses
   an illegal transition rather than clamping it. `_bank_account_derive_state`
   keeps the legacy `is_active` flag consistent so no caller has two answers.
3. **Activation requires a general ledger account.** `activate = true` without
   `account_id` raises `BANK_ACCOUNT_NEEDS_GL`. An active account with no GL link
   would make the posting engine, the position projection and the matching seam
   all unresolvable at once.
4. **The opening balance is posted, not stored twice.** It reaches the ledger via
   `post_journal_entry_atomic` inside the activating transaction
   (`_bank_account_post_opening_balance`), is idempotent on repeat, is refused in
   a locked fiscal period, and is reversed through the same engine on reset — never
   deleted (ADR-0123).
5. **Concurrency is optimistic and explicit.** Every mutating seam takes
   `row_version` and raises a conflict rather than performing a last-write-wins
   overwrite. Two controllers editing one account is a normal event, not a race
   to be ignored.
6. **Immutable facts stay immutable.** `business_id` is never re-parented.
   Currency is editable only while the account has no posted history; afterwards
   the account's history and its currency are one fact.
7. **Deletion is a draft-only affordance.** `bank_account_delete_draft` refuses
   anything past `draft`. An account that has seen a statement line or a journal
   line is closed, never erased — closure preserves the audit trail that deletion
   would destroy.

## Consequences

- Every downstream banking engine can state its precondition as a property of the
  account row and trust it, instead of re-validating client intent.
- The illegal states that used to be reachable from the browser (active without
  GL, re-parented, currency-switched mid-history, deleted with history) are now
  unreachable from any path, including a compromised client.
- New banking behaviour is added by extending a seam, not by adding a table write.
- Ratchets: `supabase/tests/bank_account_lifecycle_invariants_test.sql`,
  `supabase/tests/banking_privilege_ratchet_test.sql`, and
  `src/test/architecture/banking-write-seam.test.ts`.
