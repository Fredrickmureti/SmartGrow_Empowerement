# Existing payment → Undeposited Funds → bank deposit reconciliation

Scope: only the clearing resolution for an already-recorded customer receipt.
No general reconciliation rework.

## 1. Verified current behavior

VERIFIED FACT (live DB, canonical case):
- Payment `8b4d1a2e…` (RCP-000001), Fredrick Mureti, KES 1,670.40, dated 2026-08-18,
  `status = applied`, `deposit_account_id` = account **1340 Undeposited Funds**,
  has its own `journal_entry_id`. Exactly one such payment exists.
- Bank line `44d6847d…`, credit KES 1,670.40, reference `PMT-FM-00002`,
  description "Payment received - Fredrick Mureti - INV-00002", same business and
  branch as the payment, `is_reconciled = false`, `lifecycle_status = for_review`.

VERIFIED FACT (engine already models this correctly):
- `bank_match_candidates` has a dedicated inflow branch that finds existing
  payments by business, branch, exact amount and a date window, and returns
  `kind = 'payment'` with the effect "Debit this bank account, credit
  <holding account>". Replaying its exact predicates against the live data
  returns **this one payment**, day gap 0, not spoken for — so a deterministic
  single candidate is available.
- `_bank_match_validate` validates the `payment` kind properly: direction,
  voided status, holding account present, deposit-in-full, already-deposited,
  no charge on a direct-to-bank receipt.
- `bank_match_confirm` for `_kind IN ('payment','bill_payment')` posts exactly
  Dr bank GL / Cr the payment's own `deposit_account_id` through
  `post_journal_entry_atomic` (`source_type = 'bank_reconciliation'`), creates
  **no** second payment and touches no AR.
- `unreconcile_bank_transaction` reverses this kind by voiding only that clearing
  journal, leaving the original receipt intact.
- The UI (`ReconcileTransactionSheet`) already renders the candidate card with
  label, plain-English effect and evidence badges, and submits the candidate's
  allocations unchanged.

VERIFIED FACT (the failure):
- `bank_transactions` carries
  `CHECK (reconciled_type = ANY (ARRAY['invoice','expense','bill','transfer','manual']))`.
- `bank_match_confirm` ends with `UPDATE bank_transactions SET reconciled_type = _kind`,
  where `_kind` is the server-derived allocation kind — `'payment'`,
  `'bill_payment'` or `'account'` for these paths.
- Therefore confirming a payment-clearing match (and also an account/journal
  classification) violates the constraint and the **whole confirm transaction
  rolls back** after the journal was built: nothing posts, the line stays
  unreconciled, and the proposal is left stranded in `status = 'suggested'`.
- Corroborating evidence in the live DB: exactly one match row exists,
  created today 13:57Z on this bank line, `matched_entity_type = 'account'`,
  allocation `document_type = 'account'` pointing at 1340 Undeposited Funds,
  still `suggested`, while the bank line is still unreconciled — a confirm that
  was attempted and failed.

VERIFIED FACT (secondary, same workflow):
- `bank_match_propose` writes `status = 'suggested'`, but
  `_bank_doc_is_spoken_for` and the "already explained" guard in
  `bank_match_candidates` both test `status IN ('proposed','confirmed')`.
  `'proposed'` is not even permitted by the matches status CHECK, so an open
  proposal is invisible to both guards: the same payment can be proposed on a
  second bank line, and a stranded proposal is never surfaced as
  tier `proposed`.

UNVERIFIED HYPOTHESIS (not an implementation requirement): that the operator
never saw the candidate card. It could not be observed at runtime — this project
uses an external Supabase, so no preview session can be minted. The card's data
path is verified by replaying the engine's own predicates instead.

## 2. Verified root cause

A stale CHECK constraint on `bank_transactions.reconciled_type` predates the
clearing/categorising resolution kinds, so `bank_match_confirm` cannot record
the resolution it just posted and aborts. The accounting logic is already
correct; the write of the reconciliation state is what fails.

## 3. Target behavior

Confirming the deterministic "Deposit the recorded receipt from Fredrick Mureti"
candidate posts one entry — Dr bank 1,670.40 / Cr 1340 Undeposited Funds
1,670.40 — marks the line reconciled with `reconciled_type = 'payment'` and
`reconciled_payment_id` = the existing payment, creates no second payment, does
not touch AR, is idempotent per bank line, and reverses by voiding only that
clearing journal.

## 4. Files / RPCs / tables actually involved

- Table `public.bank_transactions` — constraint `bank_transactions_reconciled_type_check`.
- Functions `bank_match_confirm`, `_bank_doc_is_spoken_for`, `bank_match_candidates`
  (guard predicate only — the payment branch is unchanged).
- `src/hooks/useBankTransactions.ts` — `BankTransaction.reconciled_type` union.
- Tests: `supabase/tests/bank_match_resolution_invariants_test.sql`,
  `supabase/tests/bank_matching_seam_invariants_test.sql`.
- Not changed: AR/AP engines, `post_journal_entry_atomic`, FX, invoice/bill
  resolution kinds, transfer flow, `ReconcileTransactionSheet` submit contract.

## 5. Minimal change set

1. Migration: replace `bank_transactions_reconciled_type_check` with the full
   set of resolutions the seam can produce — `invoice`, `bill`, `expense`,
   `transfer`, `manual`, `payment`, `bill_payment`, `account`. No data rewrite
   (no existing row uses the new values).
2. Migration: align the open-proposal predicate with the status vocabulary the
   seam actually writes — `_bank_doc_is_spoken_for` and the explained-tier guard
   in `bank_match_candidates` test `status IN ('suggested','to_check','confirmed')`
   instead of `'proposed'`. Behaviour otherwise byte-identical.
3. Reject the stranded `suggested` match on the canonical bank line as part of
   the same migration, so the line returns to a clean unreconciled state.
   (`bank_match_propose` already auto-rejects prior open proposals, so this is
   hygiene, not a code path.)
4. Client: widen `BankTransaction.reconciled_type` to include `payment`,
   `bill_payment`, `account` so the UI can label a cleared line. Type-only.
5. UI (only if step 1–4 verification shows a gap): add the Dr/Cr pair to the
   candidate card's effect line for `kind = 'payment'`. No new tab, no new
   account picker, no journal browsing. The existing Journal fallback stays.

Explicitly out of scope: no new resolution kind, no new RPC, no parallel posting
path, no change to how candidates are scored or ranked.

## 6. Accounting invariants

- Clearing an existing receipt creates no `payments` row and no AR movement.
- Bank GL debit equals the statement amount; the credit equals the payment's own
  `deposit_account_id` — derived from the payment, never chosen by the user.
- A receipt is deposited in full and at most once (`BANK_MATCH_PAYMENT_ALREADY_DEPOSITED`).
- Journal rows only ever come from `post_journal_entry_atomic` (ADR-0123).
- Reversal voids only the clearing journal; the receipt stays applied to INV-00002.
- Tenant, branch, currency and period guards remain `assert_can_reconcile_bank`,
  `is_period_open` and `require_exchange_rate` — untouched.

## 7. Tests required

pgTAP additions to `bank_match_resolution_invariants_test.sql`:
1. `reconciled_type` accepts every kind `_bank_match_validate` can return
   (regression for the root cause).
2. Confirming a payment-clearing match: payment count unchanged, no new AR
   credit, one journal with Dr bank / Cr the holding account for the exact
   amount, `reconciled_type = 'payment'`, `reconciled_payment_id` set.
3. Second confirm of the same match returns `already_confirmed` with no second
   journal; a second bank line proposing the same payment is refused.
4. Unreconcile voids the clearing journal, leaves the payment `applied` and its
   invoice allocation intact, and returns the line to unreconciled.
5. Cross-business payment, mismatched branch, mismatched currency and a locked
   period are each refused.
6. An open (`suggested`) proposal makes the payment spoken for.

## 8. Execution status

- Phase 1–2 research: COMPLETE (findings above).
- Phase 3 change set: DEFINED, awaiting approval.
- Phase 4 UI: contingent, likely no change needed.
- Phase 5 tests: NOT STARTED.
