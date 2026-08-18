---
name: Banking domain (accounts + statement ingestion)
description: Bank account write seam RPCs, lifecycle, opening balances, the single server-side statement ingestion engine (dedup fingerprint, rules), and the server-owned reconciliation lifecycle, arithmetic and GL posting
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

## Reconciliation (Phase 4)
- Lifecycle is server-owned: `bank_reconciliation_session_start`,
  `bank_reconciliation_item_set`, `bank_reconciliation_session_writeoff`,
  `bank_reconciliation_session_complete`, `bank_reconciliation_session_cancel`.
  `authenticated` has SELECT only on `bank_reconciliation_sessions` / `_items`;
  `anon` has nothing.
- `_bank_reconciliation_recompute` is the only arithmetic authority.
  `reconciled_balance` = net cleared movement (credits +, debits −) − service
  charge + interest + write-off, so the generated
  `difference = (closing − opening) − reconciled_balance` is correct. Never let
  the client store an opening-balance-inclusive figure.
- Service charge / interest / write-off post via `post_journal_entry_atomic`
  with `source_type='bank_recon'` and subtypes `service_charge` / `interest` /
  `writeoff` — idempotent per session; never posted from the browser.
- Gates: finance permission, account must be `active`, fiscal period unlocked
  (statement date AND each adjustment date), one open session per account, a
  cleared line must share the account, be dated ≤ statement date and not be
  already reconciled, one write-off per session within the threshold (default 5.00).
- Cancelling keeps item rows as provenance (status → `uncleared`) and records
  `cancelled_at/by` + `cancel_reason`.
- `bank_transaction_set_category(_transaction_ids[], _category, _confidence)` is
  the only categorization writer.
- Ratchet: `src/test/architecture/banking-reconciliation-seam.test.ts`.

## Rule authoring (Phase 4d)
- `bank_reconciliation_rules` and `transaction_categorization_rules` are
  seam-only: `bank_reconciliation_rule_upsert` / `_delete` and
  `transaction_categorization_rule_upsert` / `_delete`. `authenticated` has
  SELECT only; `anon`/`PUBLIC` have nothing on the tables or the functions.
- The seams own scope stamping (org derived from business), the
  `finance.reconcile_bank` gate, and cross-company checks on
  bank_account_id / counterpart / target / offset accounts.
- Ratchet: `src/test/architecture/banking-rule-authoring-seam.test.ts`.


## Currency & FX (Phase 5)
- Bank account currency is chosen from the company's **active** currencies
  (`useBusinessActiveCurrencies` + shared `CurrencyCombobox`) on both create and
  edit. No free-text currency box; no country-specific bank fixtures in core
  Finance (the Kenyan Jenga/Equity test accounts were deleted).
- Editing currency stays locked once the account has posted history.
- `bank_statement_import_batch` rejects any row whose `currency` differs from
  the parent account's currency (reported in `rejected_rows`) and stamps
  `original_currency` on every inserted row.
- `reconcile_bank_transfer_atomic` refuses a cross-currency match
  (`BANK_TRANSFER_CURRENCY_MISMATCH`) — a 1:1 mirror would misstate FX.
- Ratchet: `src/test/architecture/banking-currency-integrity.test.ts`
  (combobox usage, no country fixtures, no 1:1 rate fallback).

## Cash position & lifecycle integrity (Phase 7)
- `bank_accounts.current_balance` is **dropped** (ADR-0141). Nothing maintained
  it and every rendered value was untraceable. Never reintroduce a stored
  running total on a bank account.
- `bank_account_positions(_business_id, _as_of)` (SECURITY INVOKER, EXECUTE to
  `authenticated`/`service_role`) is the only source of a bank balance:
  `opening_balance`, `statement_balance`, `last_statement_line_date`,
  `gl_balance`, `gl_shared`, `unreconciled_count`, `unreconciled_amount`.
  `gl_balance` is NULL when several accounts share one control account —
  the balance cannot be attributed, so it is not shown.
- Client contract: `useBankAccounts` merges the projection onto each row as
  `position`; `resolveBankAccountBalance()` returns `{amount, source:'gl'|'statement'}`
  or **null**. Null renders `—` (ADR-0136 rule applied to cash), never 0.
- D-8 closed: `bank_account_create` refuses `activate=true` without a linked GL
  account (`BANK_ACCOUNT_NEEDS_GL`), matching `bank_account_transition`. A draft
  no longer posts its opening balance; activation does.
- `anon` privileges on `journal_entries` / `journal_entry_lines` revoked —
  ADR-0123's posting monopoly cannot hold while those tables are publicly writable.
- Ratchet: `src/test/architecture/banking-balance-provenance.test.ts`.

## Matching seam (Wave 2, Phases 10–12)

- One matching seam, proposal → confirmation:
  `bank_match_propose(_txn_id, _allocations, _fee_amount, _match_type, _rule_id, _notes, _user_id)`
  → `bank_match_confirm(_match_id, _user_id, _client_request_id)`, with
  `bank_match_reject` and `bank_match_reverse` (the latter delegates to
  `unreconcile_bank_transaction`). EXECUTE is `authenticated` + `service_role`.
- `_allocations` is a jsonb array of
  `{document_type: 'invoice'|'bill'|'account', document_id, amount, description?}`.
  n:m allocations and partial settlement are the normal case; mixed
  invoice/bill sets, cross-company documents, over-allocation beyond a
  document's open amount, and a set that does not equal the bank line are all
  refused (`BANK_MATCH_*` error codes).
- A bank charge is the residual: `fee_amount` posts DR bank-fees / CR bank
  through `post_journal_entry_atomic`. Allocations + fee must equal `abs(amount)`.
- Confirmation never mints settlements itself: AR goes through
  `record_multi_invoice_payment`, AP through `record_multi_bill_payment`,
  classified movements through `post_journal_entry_atomic` (ADR-0123 intact).
- Accounts resolve through `_resolve_canonical_default_account`
  (`accounts_receivable`, `accounts_payable`, `bank_fees`); a bank account with
  no linked GL account refuses (`BANK_ACCOUNT_NEEDS_GL`). No `detail_type` guessing.
- FX: base-currency lines use rate 1; any other currency requires
  `require_exchange_rate` for the transaction date — no hardcoded 1 (ADR-0136).
- `apply_reconciliation_rules` proposes through the seam and only auto-confirms
  when the confirmation succeeds; a failed auto-post stays a proposal with the
  reason reported in `skipped`. It no longer writes matches directly and no
  longer stashes lifecycle state in `bank_transactions.reconciled_type`.
- `get_reconciliation_match_suggestions(_org_id, _business_id, _bank_account_id, _limit)`
  is business-scoped; the org-only signature is gone.
- `reconcile_bank_transaction_atomic` is a thin shim over propose+confirm and
  refuses `_create_gl := false` (`BANK_MATCH_GL_IS_NOT_OPTIONAL`).
