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

## Done (continued)

**Phase 16 — feed transport tests (done, verified).**
`supabase/tests/bank_feed_transport_invariants_test.sql` asserts, against the
live catalog and routine bodies: one hardened overload per feed seam
(`bank_feed_connection_resolve` / `run_start` / `run_finish` / `run_fail`,
SECURITY DEFINER, pinned search_path, never anon); concurrency is a partial
unique index on `bank_feed_runs(connection_id) WHERE status='running'` and
`run_start` maps the unique violation to `BANK_FEED_RUN_IN_FLIGHT`; one live
connection per account; a dead consent is refused (`BANK_FEED_NEEDS_REAUTH`);
`run_fail` increments `consecutive_failures` and parks auth failures as
`needs_reauth`, `run_finish` resets the counter and clears `last_error`, both
lock the run `FOR UPDATE` and are idempotent once it left `running`; the legacy
`bank_accounts` sync columns stay gone; `bank_feed_status` is SECURITY INVOKER,
STABLE and not anon-executable; RLS is on both feed tables with no write grants;
ingestion still applies rules server-side and dedup is a unique index.
Every predicate in the file was executed against the live database.

Gap found and fixed while proving it: `bank_feed_status` is SECURITY INVOKER, but
`authenticated` had **no table grant** on `bank_feed_connections` /
`bank_feed_runs`, so the read model would have failed with a permission error.
Migration grants `SELECT` to `authenticated` (RLS decides rows), `ALL` to
`service_role`, and revokes write privileges and all anon access.

**Phase 17 — ADR + ratchets (done, verified).**
- `docs/adr/0143-bank-feed-is-transport-state-lives-on-the-connection.md`
- `docs/adr/0144-bank-reconciliation-is-one-matching-seam.md`
- `src/test/architecture/bank-feed-transport-ownership.test.ts` (8 tests, green):
  the edge function never writes `bank_transactions` / `bank_statements` /
  `bank_accounts`, carries no TS rule engine, references no `current_balance` or
  legacy sync column, keeps bank provider HTTP inside `providers/` (the AI
  gateway is allowed), refuses unimplemented providers, and AI stays advisory.
- Stale ratchets in `src/test/architecture/bank-feeds-business-level-gating.test.ts`
  corrected: they still demanded a client-side `.update({ category })` with
  manual org/business filters. Categorization now goes through
  `bank_transaction_set_category`, so the tests assert the seam and forbid a
  direct update.

Banking suite state: `banking-*` and `bank-*` architecture tests are green
(63 tests) except `bank-export-template-metadata.test.ts`, which is a
localization-pack concern outside this wave and was already failing before it.

## Active phase

None — Banking → Bank Feed → Reconciliation is at a coherent, production-ready
state: one write seam per lifecycle, one ingestion engine, one matching seam,
one home for feed state, derived balances, SQL invariants + TS ratchets + ADRs
for each.

## Next

**Phase 18 — reconciliation close & reporting coherence.** The intended next
milestone, in order:
1. Prove the session close is a seam: a `bank_reconciliation_sessions` close
   must refuse while unmatched-in-scope lines remain, must pin the statement
   balance it closed against, and must be reversible only through a seam.
   Extend `supabase/tests/bank_reconciliation_lifecycle_invariants_test.sql`.
2. Make the session report and `bank_account_positions` (ADR-0141) provably
   agree: one projection for "statement balance at as-of", consumed by both.
3. Feed observability surface: expose run history (window, counts, error) on the
   banking page from `bank_feed_status` + `bank_feed_runs` — read-only, no new
   state.
4. Scheduled sync: a cron entry point that fans out over connections with
   `auto_sync_enabled`, relying on `BANK_FEED_RUN_IN_FLIGHT` for safety. Do not
   add a second scheduler or a second concurrency mechanism.

## Instructions for the next agent

1. **Verify before you build.** Run `bunx vitest run src/test/architecture/bank`
   and read the failures; then re-execute the predicates of
   `supabase/tests/bank_feed_transport_invariants_test.sql` and
   `bank_matching_seam_invariants_test.sql` against the live database (catalog
   queries, not assumptions). Confirm: no `bank_accounts.sync_status` /
   `sync_error` / `last_sync_at` / `current_balance`; `authenticated` has SELECT
   but no INSERT/UPDATE/DELETE on the feed tables; `bank_feed_status` is
   SECURITY INVOKER; the sync edge function still contains no rule engine.
2. **Then resume at Phase 18.1** — do not start unrelated work, and do not
   rebuild FX, CoA, journal posting or the payment engines; the wave delegates
   to them on purpose.
3. **Rules that hold for this wave.** The server is authoritative: no accounting
   decision may live in a browser or in Deno. Feed state lives only on the
   connection and its runs. A balance is derived, never stored. AI is advisory
   only. Every new seam is SECURITY DEFINER with a pinned `search_path`, never
   anon-executable, and every new public table ships GRANTs in its migration.
4. Keep this ledger updated as each item lands.

