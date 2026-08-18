# ADR 0143 — A bank feed is transport; feed state lives on the connection and its runs

Status: Accepted
Date: 2026-08-18
Related: ADR-0141 (a bank balance is derived, never stored), ADR-0123 (single
journal posting monopoly)

## Context

`sync-bank-transactions` used to be the whole feed: it held provider HTTP calls,
a TypeScript categorization rule engine, dedup decisions, and it wrote
`bank_transactions` and `bank_accounts.current_balance` directly. Feed state
lived on `bank_accounts` as `sync_status`, `sync_error` and `last_sync_at` — three
columns a browser could set, with no history behind them.

Two consequences. First, financial truth depended on which client had run last:
re-running a window could duplicate lines, and categorization differed between a
CSV import (database rules) and a feed import (Deno rules). Second, a broken feed
was invisible — a single overwritten `sync_error` string, no run history, no
count of what was fetched versus accepted, and nothing that could prove a window
had already been ingested.

## Decision

1. **The edge function is transport only.** It opens a run, asks a provider
   adapter for normalized lines, hands them to the one ingestion engine, and
   closes the run. It owns no accounting shape: no rules, no dedup, no balances,
   no write to `bank_transactions`.
2. **Provider specifics live behind a registry.** `providers/index.ts` maps
   `provider_code` to an adapter and *refuses* unimplemented providers and
   `manual` sources with `BANK_FEED_UNSUPPORTED_PROVIDER` rather than silently
   importing nothing.
3. **A run is a first-class record.** `bank_feed_connections` holds the consent
   and its health (`status`, `last_error`, `last_success_at`, `last_run_at`,
   `consecutive_failures`); `bank_feed_runs` holds one row per attempt with its
   window, `fetched/inserted/duplicate/rejected` counts, error code and the
   statement it produced. Every imported line traces to a run.
4. **The database owns the run lifecycle.** `bank_feed_run_start` resolves the
   connection server-side (the caller cannot invent `business_id`), refuses a
   dead consent (`BANK_FEED_NEEDS_REAUTH`), and relies on a partial unique index
   on `(connection_id) WHERE status = 'running'` to guarantee one in-flight run
   per connection — a concurrent attempt becomes `BANK_FEED_RUN_IN_FLIGHT`.
   `bank_feed_run_finish` / `bank_feed_run_fail` take the run `FOR UPDATE`, are
   idempotent once the run has left `running`, and are the only writers of
   connection health.
5. **One ingestion engine.** `bank_statement_import_batch` remains the single way
   a bank line enters the system, for CSV and for feeds alike. It owns dedup
   identity (unique `(bank_account_id, external_transaction_id)`), lifecycle and
   fiscal-period gates, deterministic categorization via
   `bank_transaction_apply_rules`, statement bookkeeping and the business event.
   Re-ingesting a window therefore inserts nothing new.
6. **AI is advisory.** `aiAdvisory.ts` may fill `ai_suggested_category` and
   `ai_confidence`. It never sets `category`, never affects matching, and a
   failure there cannot fail a run.
7. **Feed state has one home.** `bank_accounts.sync_status`, `sync_error` and
   `last_sync_at` are dropped. The UI reads `bank_feed_status(_business_id)`, a
   SECURITY INVOKER read model joining each connection to its latest run; RLS on
   the feed tables decides visibility, and `anon` can neither read the tables nor
   execute the function.
8. **A provider balance is evidence, not a balance.** It is recorded on the
   statement header; the account's position stays derived (ADR-0141).

## Consequences

- A controller can answer "when did this feed last work, over what window, and
  how many lines did it bring" from data, not from a status string.
- Retrying a sync is safe by construction: concurrency is refused by an index,
  and duplicates are refused by the ingestion engine.
- Adding a provider is an adapter plus a registry entry. It cannot smuggle in a
  second categorization or dedup policy.

## Enforcement

- `supabase/tests/bank_feed_transport_invariants_test.sql` — seam hardening,
  the concurrency index, failure/success health transitions and idempotency,
  the absence of the legacy `bank_accounts` sync columns, read-model privileges.
- `src/test/architecture/banking-write-seam.test.ts` — feed-state provenance in
  the client.
- `src/test/architecture/bank-feed-transport-ownership.test.ts` — the edge
  function stays transport only.
