# Banking Domain Reconstruction — Authoritative Status (verified handover)

Wave: Finance → Banking. Target: one server-owned write seam per concern.

```text
instruction (UI)        →  seam RPC  →  post_journal_entry_atomic → business_event_outbox
ingestion (CSV / feed)  →  bank_statement_import_batch (single engine)
reconciliation          →  server-owned lifecycle; matches only, never mints payments (ADR 0123)
```

## Phase 1 verification — CONFIRMED DONE
Lifecycle enum, `lifecycle_status/activated_at/closed_at/closed_reason/opening_balance_je_id/row_version/bank_reported_balance/bank_balance_as_of`, derive trigger — all present in the live database.

## Phase 2 verification — CONFIRMED DONE
`bank_account_create/_update/_transition/_delete_draft/_reset_opening_balances` exist, all SECURITY DEFINER with `search_path=public`. `authenticated` holds no INSERT/UPDATE/DELETE on `bank_accounts`. No direct client writes remain.

## Phase 3 verification — CONFIRMED DONE (with a red ratchet)
`bank_statement_import_batch`, `bank_transaction_fingerprint`, `bank_transaction_apply_rules` exist; `authenticated` has read-only on `bank_transactions` / `bank_statements`; `anon` has no table privilege on those three tables.

## Phase 4 verification — SUBSTANTIALLY DONE
All six reconciliation seam functions exist, SECURITY DEFINER, `search_path=public`, EXECUTE limited to `authenticated`/`service_role`. Database check confirms the residual ADR-0123 question: **no reconciliation function inserts journal rows or mints payments** — `reconcile_bank_transaction_atomic`, `reconcile_bank_transfer_atomic`, `session_complete` and `session_writeoff` all route through `post_journal_entry_atomic`. That item is satisfied in fact; it still lacks a ratchet.

## Defects found during this verification (NOT in the previous ledger)

- **V1 — the previous "grants fixed" claim is only true for three tables.** `bank_reconciliation_matches`, `bank_reconciliation_rules`, `bank_reconciliation_writeoffs` and `bank_transaction_splits` still grant **full INSERT/UPDATE/DELETE to `anon`**. Same class of hole as D-A, left open on the siblings.
- **V2 — `authenticated` still holds TRUNCATE** on `bank_accounts`, `bank_statements` and `bank_transactions`. A read-only role can destroy financial tables.
- **V3 — seam RPCs are still EXECUTE-able by `anon`**: all five `bank_account_*` functions plus `bank_statement_import_batch`. `reconcile_bank_transaction_atomic`, `bank_transaction_fingerprint` and `bank_transaction_apply_rules` are executable by `PUBLIC`. D-B was fixed only for the newer reconciliation functions.
- **V4 — a banking ratchet is currently failing.** `banking-ownership.test.ts` still asserts the old in-edge-function scope stamping that Phase 3 removed when `sync-bank-transactions` began delegating. 23/24 pass; the ledger's "12/12 pass, typecheck clean" is stale.
- **V5 — reconciliation rules are written from the browser.** `useReconciliationRules` does raw insert/update/delete on `bank_reconciliation_rules`, the table that drives server-side categorization. Rule authorship has no server seam and no permission check.
- **V6 — country-specific fixtures inside core Finance.** `BankAccountCreatePage` hardcodes named Kenyan test bank accounts, violating the country-agnostic rule.

## Remaining work, in execution order

**Phase 4c — close the privilege category, not the instances**
Single migration: revoke all `anon` table privileges and `authenticated` TRUNCATE across every banking table (accounts, transactions, statements, sessions, items, matches, writeoffs, splits, rules); revoke `PUBLIC`/`anon` EXECUTE on every banking function and re-grant to `authenticated`/`service_role` only. Extend `banking-write-seam.test.ts` with a privilege ratchet covering the whole table/function family.

**Phase 4d — reconciliation-rule write seam (V5)**
`bank_reconciliation_rule_upsert` / `_delete` (SECURITY DEFINER, `assert_can_reconcile_bank`, business-scoped); migrate `useReconciliationRules` to the RPCs and delete the direct writes. Ratchet the no-mint / no-journal-insert property of the matching path (ADR-0123 proof).

**Phase 4e — repair the stale ratchet (V4)**
Rewrite `banking-ownership.test.ts` to assert what is now true: the edge function delegates to `bank_statement_import_batch` and stamps no scope itself. Green banking suite + typecheck before moving on.

**Phase 5 — currency & FX correctness**
Replace the free-text currency inputs on bank account create/edit with a `business_active_currencies`-backed selector (shared `CurrencyCombobox`/`useCurrencies`); remove the hardcoded Kenyan fixtures (V6); confirm every banking money display resolves through `@/services/fx/rateBook` with a missing rate rendering `—`; make ingestion/reconciliation reject rows whose currency differs from the parent account. Ratchet no-1:1-fallback for the banking surface.

**Phase 6 — SQL tests + ADR**
`supabase/tests/` coverage: lifecycle guards, opening-balance atomicity/idempotency, row-version conflict, close refusal, concurrent-import dedup, reconciliation gates (period lock, second open session, cross-account line, write-off threshold, completion balance). Then an ADR for the banking write seams and a `mem://features/banking-domain` update.

## Next coherent step
Phase 4c (the privilege migration), because it is the live security hole.
