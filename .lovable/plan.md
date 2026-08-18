# Finance Wave 2 — Banking, Bank Feeds & Reconciliation (execution ledger)

## Done

**Phases 10–13 — one matching seam.** `bank_match_propose` / `_confirm` /
`_reject` / `_reverse` with n:m allocations, partial settlement, bank-charge
residual, canonical default accounts, canonical FX (`require_exchange_rate`),
settlement delegated to `record_multi_invoice_payment` /
`record_multi_bill_payment`, GL only via `post_journal_entry_atomic`. SQL
invariant tests in `supabase/tests/`.

**Phase 14 — feed transport, one ingestion engine.**
- `bank_feed_connections` + `bank_feed_runs`: every imported line traces to a run.
- `sync-bank-transactions` is transport only: `bank_feed_run_start` opens the
  run (and owns concurrency), a provider adapter (`providers/index.ts`,
  registry keyed by `provider_code`, unimplemented and `manual` sources
  refused) normalizes rows, `bank_statement_import_batch` is the single
  ingestion engine, `bank_feed_run_finish` closes the run.
- Categorization is server-side (`bank_transaction_apply_rules`, called by the
  import batch). The Deno rule engine is gone. AI is advisory only
  (`aiAdvisory.ts` → `ai_suggested_category` / `ai_confidence`); it never
  drives accounting.

**Phase 14d — feed state has one representation.** Dropped
`bank_accounts.sync_status` / `sync_error` / `last_sync_at`. Added
`bank_feed_status(_business_id)` (SECURITY INVOKER read model: connection
health + latest run window, counts, error). `useBankAccounts` exposes
`account.feed`; `BankAccountCard` renders badge, error, last-sync and imported
count from it. Ratchet updated in
`src/test/architecture/banking-write-seam.test.ts`.

**Phase 15 — orphan removal.** Dropped `bank_transaction_splits` (a split bank
line is represented once, as allocations on the matching seam), the legacy
`reconciliation_sessions` table and `bank_transactions.reconciliation_session_id`,
and the stale cleanup reference in `reset_module__inventory`.
Correction to the earlier note: `bank_reconciliation_sessions` is **not** an
orphan — it has seams, reports and RLS tests, and stays.

## Remaining

**Phase 16 — feed transport tests.** `supabase/tests/bank_feed_transport_test.sql`:
`bank_feed_run_start` refuses a second concurrent run per connection, a
failed run increments `consecutive_failures`, a succeeded run resets it,
re-ingesting the same provider rows inserts nothing new (idempotency by
external id), `bank_feed_status` is SECURITY INVOKER and not executable by
`anon`.

**Phase 17 — ADR + ratchet.** ADR for the matching seam (propose/confirm,
no-mint, fee residual, FX refusal) and for feed-state provenance (state lives
on the connection and its runs). Architecture test forbidding direct
`bank_reconciliation_matches` / `bank_transactions` writes from app code
(partly in place — extend to the feed tables).
