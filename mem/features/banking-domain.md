---
name: Banking domain (accounts + statement ingestion)
description: Bank account write seam RPCs, lifecycle, opening balances, and the single server-side statement ingestion engine with its dedup fingerprint and rule categorization
type: feature
---

# Banking — server-owned write seams

## Bank accounts
- Mutations only via SECURITY DEFINER RPCs: `bank_account_create`,
  `bank_account_update`, `bank_account_transition`, `bank_account_delete_draft`,
  `bank_account_reset_opening_balances`. `authenticated` has SELECT only.
- Lifecycle enum `bank_account_lifecycle_status`: draft | active | suspended | closed.
  Optimistic concurrency via `row_version`; `_bank_account_derive_state` trigger.
- Opening balances post through `post_journal_entry_atomic` in the same
  transaction (`_bank_account_post_opening_balance`), never a client insert.

## Statement ingestion (Phase 3)
- `bank_statement_import_batch(_bank_account_id, _rows, _statement, _source)` is
  the ONLY writer of `bank_transactions` / `bank_statements`. Both the manual
  wizard (`ImportStatementWizardPage`) and the provider feed
  (`sync-bank-transactions`) call it; `authenticated` has SELECT only on both tables.
- It owns, in one transaction: dedup identity, categorization, account-lifecycle
  gate (active only), fiscal-period lock gate (`is_period_locked`, per row →
  reported as `rejected_rows`), statement header bookkeeping, and the
  `banking.statement.imported` business event.
- Dedup identity: provider `external_transaction_id` wins; otherwise
  `bank_transaction_fingerprint()` — a SQL port of `generateTransactionHash`
  (FNV-1a double pass, `imp_<16 hex>`), byte-for-byte identical so the browser
  can still preview duplicate counts. Never let the client supply the hash.
- Categorization: `bank_transaction_apply_rules()` mirrors
  `transaction_categorization_rules` server-side; a caller-supplied `category`
  (e.g. the feed's AI classification) is respected and skips rules.
- Duplicates are skipped, never updated — an imported statement row is an
  immutable fact.
- Callers: interactive callers need `finance.reconcile_bank`
  (`assert_can_reconcile_bank`); service_role feeds pass with no `auth.uid()`;
  anonymous is refused. `anon` holds no privilege on any banking table.
- Ratchets: `src/test/architecture/banking-write-seam.test.ts`,
  `src/test/architecture/banking-ingestion-single-engine.test.ts`.
