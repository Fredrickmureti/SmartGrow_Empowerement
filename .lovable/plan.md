# Finance Wave 1 — Banking Domain Reconstruction (authoritative status)

Seam model:

```text
instruction (UI)        →  seam RPC  →  post_journal_entry_atomic → business_event_outbox
ingestion (CSV / feed)  →  bank_statement_import_batch (single engine)
reconciliation          →  server-owned lifecycle; matches only, never mints payments (ADR 0123)
```

## Completed and verified

- **Phase 1 — schema/lifecycle.** `bank_account_lifecycle_status`, `row_version`,
  `opening_balance_je_id`, derive trigger. Verified live.
- **Phase 2 — bank account write seams.** `bank_account_create/_update/_transition/
  _delete_draft/_reset_opening_balances`, all SECURITY DEFINER, `search_path=public`.
  `authenticated` has SELECT only. Verified live.
- **Phase 3 — single ingestion engine.** `bank_statement_import_batch` +
  `bank_transaction_fingerprint` + `bank_transaction_apply_rules`; wizard and
  `sync-bank-transactions` both delegate. Verified live.
- **Phase 4 — reconciliation lifecycle.** Six seam functions; arithmetic owned by
  `_bank_reconciliation_recompute`; all GL effects via `post_journal_entry_atomic`
  (ADR-0123 satisfied in fact, verified by reading each function body).
- **Phase 4c — privilege closure.** All `anon`/`PUBLIC` table privileges revoked
  across the banking family (accounts, transactions, statements, sessions, items,
  matches, writeoffs, splits, rules); `authenticated` TRUNCATE revoked; banking
  function EXECUTE restricted to `authenticated`/`service_role`.
- **Phase 4d — rule authoring seam.** `bank_reconciliation_rule_upsert/_delete` and
  `transaction_categorization_rule_upsert/_delete`; `useReconciliationRules` and
  `useTransactionRules` migrated off direct writes; table writes revoked.
  Ratchet: `banking-rule-authoring-seam.test.ts`.
- **Phase 4e — stale ratchet repaired.** `banking-ownership.test.ts` now asserts
  the delegation model. Banking suite green (15/15 across three files), typecheck clean.
- **Phase 5 — currency & FX correctness (THIS WAVE, DONE).**
  - `useBusinessActiveCurrencies` hook (system catalogue ∩ `business_active_currencies`,
    falling back to `businesses.base_currency`).
  - `BankAccountCreatePage` / `BankAccountEditPage`: free-text currency inputs replaced
    with the shared `CurrencyCombobox`; edit stays locked once the account has history.
  - Hardcoded Kenyan Jenga/Equity test fixtures removed; sandbox handling is now a
    generic provider notice.
  - Migration: `bank_statement_import_batch` rejects rows whose currency differs from
    the parent account (reported in `rejected_rows`) and stamps `original_currency`;
    `reconcile_bank_transfer_atomic` refuses cross-currency matches
    (`BANK_TRANSFER_CURRENCY_MISMATCH`). EXECUTE re-restricted after redefinition.
  - Ratchet: `src/test/architecture/banking-currency-integrity.test.ts`.
  - Memory updated: `mem/features/banking-domain.md`.

## Currently active phase

None — Phase 5 is closed. Phase 6 is next and not started.

## Pending

**Phase 6 — SQL tests + ADR (next milestone).**
1. `supabase/tests/` coverage: lifecycle guards; opening-balance atomicity and
   idempotency; `row_version` conflict; close refusal with open items; concurrent
   import dedup; reconciliation gates (period lock, second open session, cross-account
   line, write-off threshold, completion balance); currency-mismatch rejection on
   import; cross-currency transfer refusal.
2. ADR documenting the banking write seams (accounts, ingestion, reconciliation,
   rule authoring) and the ADR-0123 no-mint property.
3. Final privilege re-verification sweep after all Phase 5/6 function redefinitions
   (a `CREATE OR REPLACE` can restore default EXECUTE — check every banking function
   again at the end).

## Instructions for the next agent

1. **Verify before you build.** Re-run
   `bunx vitest run src/test/architecture/banking-*.test.ts` and a typecheck. Then
   query `pg_proc`/`information_schema.role_table_grants` for the banking family and
   confirm: no `anon`/`PUBLIC` privilege on any banking table or function, no
   `authenticated` TRUNCATE, no `authenticated` INSERT/UPDATE/DELETE on
   `bank_transactions`, `bank_statements`, `bank_reconciliation_*`,
   `transaction_categorization_rules`.
2. Confirm the Phase 5 guards actually fire (currency mismatch on import; cross-currency
   transfer refusal) rather than trusting this document.
3. **Then resume at Phase 6**, in the order listed above. Do not start unrelated Finance
   areas (AP/AR, fixed assets, reporting) until Phase 6 closes the banking wave with
   SQL tests and an ADR.
