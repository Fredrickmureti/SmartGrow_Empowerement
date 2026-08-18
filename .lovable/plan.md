# Banking Domain Reconstruction — Authoritative Status

Wave: Finance → Banking (multi-tenant, multi-branch, country-agnostic).
Target architecture: one server-owned write seam per concern.

```text
instruction (UI)        →  seam RPC  →  post_journal_entry_atomic
                                     →  business_event_outbox
ingestion (CSV / feed)  →  ONE normalization + dedup engine  →  bank_transactions
reconciliation          →  server-owned lifecycle; matches only, never mints payments (ADR 0123)
```

---

## Phase 1 — Account schema, lifecycle & provenance — VERIFIED DONE

`bank_account_lifecycle_status` enum; `lifecycle_status`, `activated_at`,
`closed_at`, `closed_reason`, `opening_balance_je_id`, `row_version`,
`bank_reported_balance`, `bank_balance_as_of` on `bank_accounts`; trigger
`_bank_account_derive_state`. Book balance and bank-reported balance are
separate facts.

## Phase 2 — Server-owned account write seam — VERIFIED DONE

`bank_account_create / _update / _transition / _delete_draft /
_reset_opening_balances`, all `SECURITY DEFINER`. `authenticated` holds SELECT
only on `bank_accounts`. Opening balance posts through
`_bank_account_post_opening_balance` → `post_journal_entry_atomic`, idempotent
via `opening_balance_je_id`. Ratchets: `banking-write-seam.test.ts`,
`banking-ownership.test.ts`.

## Phase 3 — Statement ingestion convergence — DONE

- `bank_statement_import_batch` is the only writer of `bank_transactions` /
  `bank_statements`. Both the manual wizard and `sync-bank-transactions` call it.
- Server-side dedup identity (`bank_transaction_fingerprint`, a byte-identical
  SQL port of the browser FNV-1a hash) and server-side categorization
  (`bank_transaction_apply_rules`).
- Account-lifecycle gate, per-row fiscal-period gate (`rejected_rows`),
  statement header bookkeeping and the `banking.statement.imported` event, all
  in one transaction.
- Defects D-A (anon write grants) and D-B (`PUBLIC`/`anon` EXECUTE on seam
  RPCs) fixed for the banking tables and functions in the same migration.
- Ratchet: `banking-ingestion-single-engine.test.ts`.

## Phase 4 — Reconciliation hardening — DONE (needs verification pass)

Migration applied. Defects fixed: browser-orchestrated 5-round-trip lifecycle,
client-computed cleared balance disagreeing with the stored generated
`difference` (net-movement vs opening-inclusive), client-side GL posting of
service charge / interest / write-off, client bulk flip of
`bank_transactions.is_reconciled`, and unrestricted client categorization.

Server seam (all `SECURITY DEFINER`, `authenticated`+`service_role` EXECUTE only):

- `bank_reconciliation_session_start(_bank_account_id, _statement_date, _opening_balance, _closing_balance, _adjustments jsonb)`
  — validates statement date, fiscal-period lock, adjustment amounts and that
  adjustment accounts belong to the org; refuses a second open session;
  stamps org/business/branch from the parent account; emits
  `banking.reconciliation.started`.
- `bank_reconciliation_item_set(_session_id, _transaction_id, _cleared)` —
  session must be in progress, line must belong to the same account, be dated
  on or before the statement date and not already reconciled. Returns the
  recomputed arithmetic.
- `bank_reconciliation_session_writeoff(_session_id, _max_amount default 5.00)`
  — server recomputes the difference, enforces the threshold, posts through
  `post_journal_entry_atomic` (`source_subtype = 'writeoff'`), records
  `writeoff_amount` / `writeoff_je_id`, single write-off per session.
- `bank_reconciliation_session_complete(_session_id)` — re-checks balance,
  posts service charge and interest through the canonical engine (idempotent on
  `bank_recon` + session id + subtype), stamps cleared lines as reconciled, and
  emits `banking.reconciliation.completed` — one transaction.
- `bank_reconciliation_session_cancel(_session_id, _reason)` — keeps item rows
  as provenance, downgrades them to `uncleared`, records cancellation actor and
  reason.
- `_bank_reconciliation_recompute` owns all arithmetic;
  `reconciled_balance` is now the net cleared movement plus adjustments, which
  makes the stored generated `difference` correct.
- `bank_transaction_set_category(_transaction_ids[], _category, _confidence)` —
  the categorization write seam, permission-checked per business.

Privileges: `authenticated` has SELECT only on
`bank_reconciliation_sessions` / `_items`; `anon` has nothing.

Client: `useReconciliationSessions` (RPC-only lifecycle, `postToGL` removed),
`useReconciliationItems` (RPC clearing, server `calc`, `markAllReconciled`
deleted), `ReconciliationWorkspace` (`onWriteOff` replaces `onUpdateBalance`,
displays the server's cleared balance / difference), `useBankTransactions` and
`BankFeeds` (categorization via RPC).

Ratchet: `src/test/architecture/banking-reconciliation-seam.test.ts` — 12/12
banking architecture tests pass; typecheck clean.

Still open inside Phase 4 (carry into the verification pass):
`bank_reconciliation_matches` and `reconcile_bank_transaction_atomic` /
`unreconcile` still need an explicit ADR-0123 proof that matching never mints a
payment outside `record_multi_invoice_payment` / `record_multi_bill_payment`,
plus a ratchet asserting it.

---

## ACTIVE PHASE → Phase 5 — Currency & FX correctness in Banking (PENDING)

1. Replace the free-text currency input on bank account create/edit with a
   `business_active_currencies`-backed selector.
2. Confirm every banking money display resolves through
   `@/services/fx/rateBook` — missing rate renders `—`, never 1:1, never a rate
   literal (ADR 0136).
3. Reconciliation and ingestion must reject rows whose currency differs from
   the parent account's currency, or record the account currency explicitly.
4. Ratchet the no-1:1-fallback rule for the banking surface.

## Phase 6 — SQL tests + documentation (PENDING)

`supabase/tests/` coverage for lifecycle guards, opening-balance atomicity and
idempotency, row-version conflicts, close refusal, ingestion dedup under
concurrent imports, and the reconciliation gates (period lock, second open
session, cross-account line, write-off threshold, completion balance check).
Then an ADR for the banking write seams.

---

## Instructions for the next agent

1. **Verify Phase 4 before writing new code.** Confirm in the live database
   that the six new functions exist and are `SECURITY DEFINER` with
   `search_path = public`; that `authenticated` has no INSERT/UPDATE/DELETE on
   `bank_reconciliation_sessions` / `_items` and `anon` has no privilege; that
   `_bank_reconciliation_recompute`'s net-movement definition agrees with the
   generated `difference` column; and that a completed session's service
   charge, interest and write-off entries are idempotent under retry. Run the
   banking architecture tests and the typecheck.
2. Close the residual Phase 4 item above (ADR-0123 proof + ratchet for
   `bank_reconciliation_matches`) so the phase is coherent.
3. Then resume at **Phase 5** in the order listed. Do not jump to Phase 6 or to
   unrelated domains, and do not leave a partially migrated currency surface.
4. Update this ledger at the end of every phase.
