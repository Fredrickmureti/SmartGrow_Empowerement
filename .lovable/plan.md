# Finance Wave 2 — Bank matching & feeds (execution ledger)

## Done

**Phase 10–11 — one matching seam.** `bank_match_propose` / `bank_match_confirm`
/ `bank_match_reject` / `bank_match_reverse`. n:m allocations, partial
settlement, bank-charge residual, canonical default-account resolution,
canonical FX (`require_exchange_rate`), settlement delegated to
`record_multi_invoice_payment` / `record_multi_bill_payment`, GL via
`post_journal_entry_atomic` only. Closes D-9 and D-10.

**Phase 12 — no second engine, correct scoping.**
- `apply_reconciliation_rules` proposes through the seam; auto-post confirms
  through the seam or leaves an auditable proposal with a reason (D-12).
- `get_reconciliation_match_suggestions` is business-scoped (D-11); the
  org-only signature is dropped. Client passes `currentBusiness.id`.
- `reconcile_bank_transaction_atomic` reduced to a shim; `_create_gl := false`
  is refused.
- `useBankTransactions.reconcileTransaction` calls propose+confirm and accepts
  `allocations` / `feeAmount` for partial and multi-document matches.

## Remaining

**Phase 13 — SQL invariant tests for the seam** (`supabase/tests/`): unbalanced
set refused, over-allocation refused, mixed document types refused,
cross-company refused, locked period refused, missing FX rate refused, fee
posts exactly two lines, confirm is idempotent per `_client_request_id`,
reverse restores `for_review`.

**Phase 14 — feed connection model (D-13/D-14).** Introduce
`bank_feed_connections` and `bank_feed_runs` (status, window, counts, error) so
every imported line traces to a run. Reduce `sync-bank-transactions` to
provider transport that normalizes rows and calls
`bank_statement_import_batch`; move the Kenya/Jenga specifics behind a provider
adapter.

**Phase 15 — orphan removal (D-15).** Drop `reconciliation_sessions` and
`bank_transaction_splits` (both 0 rows, no readers) or fold splits into the
allocation model — one representation of a split bank line only.

**Phase 16 — ADR + ratchet.** ADR for the matching seam (propose/confirm,
no-mint, fee residual, FX refusal) plus an architecture test forbidding direct
`bank_reconciliation_matches` writes from app code.
