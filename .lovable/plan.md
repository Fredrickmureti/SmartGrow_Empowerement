# Finance Wave 2 — Banking, Bank Feeds & Reconciliation (execution ledger)

## Verification of the previous engineer's claims (this session)

Checked against the live database catalog and the test suite, not the notes:

- **Phases 10–17 hold.** `banking-*` / `bank-*` architecture tests: 62 passing,
  1 failing — `bank-export-template-metadata.test.ts`, a localization-pack
  concern outside this wave and failing before it.
- `bank_accounts` has none of `sync_status`, `sync_error`, `last_sync_at`,
  `current_balance` — feed state and cash position have one home each.
- `bank_feed_status(uuid)` exists and is SECURITY INVOKER; `bank_account_positions(uuid, date)` exists.
- `sync-bank-transactions` is 259 lines, transport only, with `providers/index.ts`
  registry + `providers/jenga.ts` + `aiAdvisory.ts`.
- `bank_reconciliation_session_complete` is SECURITY DEFINER, takes the session
  `FOR UPDATE`, refuses a locked period, refuses an unexplained difference
  (> 0.01) and posts service charge / interest through `post_journal_entry_atomic`.
- No bank-feed entry exists in `cron.job` — scheduled sync is genuinely absent.

Conclusion: resume at Phase 18 as the previous ledger states. No rework of
Phases 10–17 is warranted.

## Phase 18 — reconciliation close & feed observability

### 18.1 Close is a proven seam
`bank_reconciliation_lifecycle_invariants_test.sql` (176 lines) does not yet
assert the close semantics. Extend it to prove, against routine bodies and live
behaviour:
- completion refuses while the recomputed difference is unexplained, and
  refuses a locked period (both for the statement date and the adjustment dates);
- the closing/statement balance the session closed against is pinned on the
  session and cannot drift afterwards;
- completion is idempotent — a second call on a completed session is refused
  with `BANK_RECON_SESSION_CLOSED`, never double-posts the service-charge or
  interest journal (source identity is the guard);
- reversal/cancel is only reachable through `bank_reconciliation_session_cancel`,
  never a direct write.
If a claim above turns out not to hold in the routine, fix the routine in the
same phase rather than weakening the test.

### 18.2 One statement-balance projection
The session report and `bank_account_positions` (ADR-0141) must agree by
construction. Introduce a single "balance at as-of date" projection and make
both consume it; `_bank_reconciliation_recompute` stops computing its own
variant. Add an invariant test asserting the two agree for the same account and
date.

### 18.3 Feed observability on the banking page
`bank_feed_status` is already consumed by `useBankAccounts` / `BankAccountCard`.
Add read-only run history (window, fetched/inserted/duplicate/rejected counts,
error code, trigger source) from `bank_feed_runs`, surfaced per account. No new
state, no client-side feed logic, RLS decides visibility.

### 18.4 Scheduled sync
One cron entry point that fans out over connections with `auto_sync_enabled`,
invoking the existing transport function per connection. Concurrency safety
comes only from the existing partial unique index →
`BANK_FEED_RUN_IN_FLIGHT`; no second scheduler, no second concurrency
mechanism, no retry storm (an in-flight run is skipped, not retried).

## Rules that hold for this wave

- Server-authoritative: no accounting decision in a browser or in Deno.
- Feed state lives only on the connection and its runs; a balance is derived.
- AI stays advisory.
- Every new seam is SECURITY DEFINER with a pinned `search_path`, never
  anon-executable; every new public table ships GRANTs in its migration.
- Delegate to the canonical FX, CoA, journal, fiscal-period and payment engines;
  do not rebuild them.

## Out of scope

`bank-export-template-metadata.test.ts` (localization pack). Recorded, not fixed
here.
