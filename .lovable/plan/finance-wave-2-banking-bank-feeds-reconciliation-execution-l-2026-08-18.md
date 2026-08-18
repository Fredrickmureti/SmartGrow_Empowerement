# Finance Wave 2 — Banking, Bank Feeds & Reconciliation (execution ledger)

## Verified this session

- **Phase 10–12 (matching seam)** — `bank_match_propose/confirm/reject/reverse`
  exist; `reconcile_bank_transaction_atomic` is a shim; settlement delegates to
  `record_multi_invoice_payment` / `record_multi_bill_payment`; GL only through
  `post_journal_entry_atomic`.
- **Phase 13 (SQL invariant tests)** — present:
  `bank_matching_seam_invariants_test.sql`, plus lifecycle, ingestion, ownership
  and privilege-ratchet suites. Counted as done; will be re-run as part of the
  Phase 14 close-out rather than rewritten.
- **Phase 14 database half — genuinely applied.** `bank_feed_connections` (19
  cols) and `bank_feed_runs` (21 cols) exist. Seams
  `bank_feed_connection_resolve`, `bank_feed_run_start`, `bank_feed_run_finish`,
  `bank_feed_run_fail` exist, all SECURITY DEFINER. `run_start` refuses a second
  in-flight run (`BANK_FEED_RUN_IN_FLIGHT`) and refuses `needs_reauth`;
  `run_fail` escalates to `needs_reauth`/`error` and counts consecutive
  failures; `run_finish` is idempotent and marks `partial` when rows were
  rejected. Row counts are 0 — nothing has exercised them yet.
- **Phase 14 edge half — NOT done.** `providers/types.ts` (adapter contract) and
  `providers/jenga.ts` exist, but `sync-bank-transactions/index.ts` is
  untouched (796 lines): it still contains its own inline Jenga fetchers with
  `Date.now()/Math.random()` external IDs (dedup-defeating), its own
  `transaction_categorization_rules` engine in Deno, and it still writes
  `bank_accounts.current_balance` — a column dropped by D-7, so the sync errors
  at runtime today. `providers/index.ts` does not exist, so nothing routes to
  the new adapter.
- **Phase 15 targets are empty and safe to drop**: `bank_transaction_splits` 0
  rows, `bank_reconciliation_sessions` 0 rows, legacy `reconciliation_sessions`
  table still present.
- `platform_bank_providers` carries 10 provider codes (absa, coop_connect,
  dtb_astra, im_bank, jenga, kcb_buni, manual, ncba, stanbic, stanchart); only
  Jenga has an adapter.
- `bank_statement_import_batch` does **not** apply
  `transaction_categorization_rules`. The previous engineer's note ("let the DB
  apply rules") is wrong as stated — dropping the Deno rule engine without a
  server-side replacement would silently remove categorization.

## Remaining work

### Phase 14a — provider registry
`providers/index.ts`: map `provider_code` → adapter. Jenga resolves to the new
adapter; the other nine raise `FeedError('BANK_FEED_UNSUPPORTED_PROVIDER')`.
`manual` is not a feed provider and is refused at the registry.

### Phase 14b — categorization owner (blocks 14c)
Move rule categorization server-side so the edge function can stop owning it:
add `bank_transaction_categorize_batch` (or fold the rule pass into
`bank_statement_import_batch`) applying `transaction_categorization_rules` by
description/reference pattern, amount band and transaction type, writing
`category` + `category_confidence`. Deterministic, no AI. The edge function then
supplies only the AI advisory fields (`ai_suggested_category`, `ai_confidence`,
`ai_reasoning`), which stay advisory and never drive accounting.

### Phase 14c — rewrite `sync-bank-transactions/index.ts` as transport only
Sequence: authorize caller → `bank_feed_run_start` → registry lookup → adapter
fetch for the run window → `bank_statement_import_batch` → optional AI advisory
pass → `bank_feed_run_finish`, with every `FeedError` and unexpected throw
routed to `bank_feed_run_fail` with its code. Delete the inline Jenga fetchers,
the Deno rule engine, and the `bank_accounts.current_balance` write. Cash
position stays derived via `bank_account_positions` (ADR-0141); a
provider-reported balance is recorded on the run/statement as evidence only.
`BANK_FEED_RUN_IN_FLIGHT` returns a conflict rather than a retry storm.

### Phase 14d — feed observability in the UI
Surface connection status, last success, last error and last run counts on the
bank account cards / banking page from `bank_feed_connections` +
`bank_feed_runs` (read-only, RLS-scoped). No client-side feed logic.

### Phase 15 — orphan removal
Drop `bank_transaction_splits`, `bank_reconciliation_sessions` and legacy
`reconciliation_sessions` (all empty), plus stale types/hooks. Confirm no reader
remains first. A split bank line has exactly one representation: allocations on
the matching seam.

### Phase 16 — ADR + ratchets
ADR for the matching seam (propose/confirm, no minting, fee residual, FX
refusal) and for feed transport (adapters normalize, seams persist). Ratchet
tests: no direct `bank_reconciliation_matches` write from app/edge code; no edge
function writes `bank_transactions` directly; every `platform_bank_providers`
code resolves through the registry; `bank_accounts.current_balance` stays gone
(existing provenance test extended to edge functions).

### Phase 17 — feed test coverage
SQL: `run_start` refuses concurrent runs and `needs_reauth`; `run_fail`
escalates status; `run_finish` idempotent and `partial` on rejects; connection
resolve is business-scoped and refuses unscoped accounts. Deno: adapter
normalization is deterministic, external IDs are stable across two fetches of
the same window, unsupported provider fails fast.

## Technical notes

- Adapters are pure transport: no DB access, no categorization, no ledger.
- Seams stay `service_role`-only; the browser never calls them.
- Core feed engine stays country-agnostic — Kenya/Jenga specifics live only in
  `providers/jenga.ts`.
