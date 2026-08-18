
## Phase 18 — applied (this session)

- `_bank_account_movement` is the single signed-movement projection;
  `bank_account_positions` and `_bank_reconciliation_recompute` both derive
  from it, so the position card and the reconciliation difference cannot
  disagree.
- `bank_reconciliation_session_complete` no longer writes the dropped
  `bank_transactions.reconciliation_session_id`; session membership lives only
  on the session's cleared items.
- `bank_reconciliation_session_freeze` trigger: a completed/cancelled session
  is immutable and cannot be reopened.
- `bank_feed_dispatch_due()` + hourly `bank-feeds-scheduled-sync` cron job;
  in-flight and not-yet-due connections are skipped, execution revoked from
  anon/authenticated.
- UI: `useBankFeedRuns` + `BankFeedRunHistoryDialog`, read-only run history from
  the bank account card.
- Invariants 6–8 added to `bank_reconciliation_lifecycle_invariants_test.sql`.
