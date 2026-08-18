# Banking Domain — Wave 3: verification verdict and closure

## What I verified before writing this plan

Two Banking waves already ran (ledgers dated 2026-08-18). I re-checked their claims
against the live database and the test suite rather than the notes.

Confirmed true today:

- **Account identity and lifecycle are server-owned.** `bank_account_create/_update/
  _transition/_delete_draft/_reset_opening_balances` all exist and are SECURITY DEFINER;
  the browser holds no write privilege on banking tables.
- **One ingestion engine.** `bank_statement_import_batch` (+ `bank_transaction_fingerprint`,
  `bank_transaction_apply_rules`) is the only way a bank line enters the system, for CSV
  and feeds alike.
- **A balance is derived, never stored.** `bank_accounts` has no `current_balance`,
  `sync_status`, `sync_error` or `last_sync_at`; `bank_account_positions` is the single
  cash-position projection (ADR-0141).
- **Feed is transport.** `bank_feed_run_start/_finish/_fail`, `bank_feed_status`, run
  history surfaced in the UI (`useBankFeedRuns`, `BankFeedRunHistoryDialog`), and a cron
  entry `bank-feeds-scheduled-sync` calling `bank_feed_dispatch_due()` (ADR-0143).
- **Reconciliation matches, never mints.** All session/match seams are SECURITY DEFINER
  and every one of them is permission-gated — directly via `assert_can_reconcile_bank`
  or through `_bank_reconciliation_assert_account`, which performs that check. GL effects
  route through `post_journal_entry_atomic` (ADR-0123, ADR-0144).
- **One movement projection.** Both `bank_account_positions` and
  `_bank_reconciliation_recompute` derive movement from `_bank_account_movement`, so the
  cash card and the reconciliation report cannot disagree.
- **Banking architecture suite:** 62 passing, 1 failing (`bank-export-template-metadata`,
  a localization-pack concern, out of this domain).

So the domain reconstruction the request describes is substantially in place. What is
left is closure work, not another rebuild. Adding new engines here would be the mistake.

## Gaps this wave closes

### 1. A stale ratchet is lying about reconciliation scoping

`src/test/architecture/reconciliation-business-level-gating.test.ts` fails on 8
assertions. The properties it guards **do hold** in the database: `branch_id` exists on
`bank_reconciliation_sessions`, `assert_can_reconcile_bank` exists, the four
`bank_recon_sessions_*_perm_v1` policies and `bank_recon_matches_write_perm_v1` exist,
and `useReconciliationSessions` exposes `canReconcile` and filters by branch.

The test is wrong in method: it greps "the latest migration that mentions X", which a
later migration displaced, and it expects the hook to stamp `branch_id` inline — the hook
now submits through `bank_reconciliation_session_start`, which is the correct shape.

Action: rewrite it to assert the *properties* (every reconciliation seam is
permission-gated, no client-side branch stamping, hook exposes the permission) rather
than migration text. A ratchet that fails for a good architecture trains engineers to
ignore ratchets.

### 2. No ADR covers bank account identity and lifecycle

ADRs exist for cash position (0141), feeds (0143) and matching (0144). The oldest and
most load-bearing decision — that a bank account is a server-owned identity with a
lifecycle state machine and no client writes — is recorded only in a plan ledger.

Action: write `docs/adr/0145-bank-account-is-a-server-owned-identity.md` covering: what a
bank account represents (business ↔ institution ↔ external account ↔ ERP identity ↔ GL
account), the lifecycle transitions and who may perform them, the GL mapping rule
(optional link, shared control account makes `gl_balance` unattributable), currency owned
by the canonical registry, and the write-seam monopoly. Refresh
`mem/features/banking-domain.md` to point at it.

### 3. ADR numbering collision

`0141` and `0142` are each used by two unrelated ADRs (banking/supplier, inventory/
supplier). Harmless today, confusing in a year. Renumber the two supplier ones and fix
inbound references.

### 4. SQL invariant suites are unrun in CI

Seven `supabase/tests/bank_*.sql` suites encode the real invariants but nothing runs them
on change. Action: document the run command in `supabase/tests/README` (or extend the
existing test doc) and record the dependency; wiring a Postgres CI job is a platform task
outside this wave.

## Recorded dependencies, not fixed here

- `bank-export-template-metadata.test.ts` — localization-pack metadata contract; belongs
  to the localization wave, failed before Banking and is unrelated to it.
- Repository-wide, 109 architecture test files currently fail; the vast majority are
  migration-text ratchets of the same stale class as gap 1, in other domains. Fixing them
  is its own wave, and worth scheduling — that failure volume makes the whole suite
  non-signalling.

## Verification for this wave

- `bunx vitest run src/test/architecture/bank src/test/architecture/reconciliation-business-level-gating.test.ts`
  → all green except the recorded localization failure.
- Re-query `pg_proc.proacl` / `pg_class.relacl` for the banking family after any change,
  asserting no `anon`/`PUBLIC` privilege survived.
- Typecheck clean.

## Technical notes

No migration is required for gaps 1–4: the database already holds the target shape. The
changes are one test file rewrite, one new ADR, two ADR renames plus reference updates,
and a memory refresh.
