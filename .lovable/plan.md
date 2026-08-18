# Finance Wave 1 — Banking Domain Reconstruction

Wave: BANKING. Status: investigation complete, implementation not started.

## Verified architecture (read from code + live DB)

Bank account model (`public.bank_accounts`): org/business/branch scope, `is_shared`,
`account_id` (GL link), `currency text` (default `'USD'`), `current_balance`,
`opening_balance` + `opening_balance_date`, `account_type`, provider identity
(`provider_id`, `external_account_id`, encrypted tokens), sync state
(`sync_status`, `last_sync_at`, `sync_error`, `auto_sync_enabled`).
No lifecycle status column, no `row_version`, no link to the opening-balance
journal entry.

Canonical engines that already exist and must be consumed, not duplicated:

- Posting: `post_journal_entry_atomic` (ADR 0123 — sole journal writer).
- Currency/FX: `businesses.base_currency` + `business_active_currencies`
  (+ `normalize_currency_code`), enforced by trigger
  `enforce_bank_account_currency`; client display via `@/services/fx/rateBook`.
- GL integrity: trigger `enforce_active_bank_account_has_gl` (active account
  must have `account_id`); `ensure_opening_balance_equity_account(org, business)`.
- Scope integrity: `cascade_bank_account_scope_to_txns`,
  `enforce_bank_txn_scope_matches_account`, `enforce_bank_txn_business_match`,
  `validate_bank_transaction_accounting_scope`.
- Authorization: RLS v3 policies on `bank_accounts` (business + branch +
  `finance.manage_bank_accounts`), `assert_can_manage_bank_accounts`,
  `assert_can_reconcile_bank`; SoD audit trigger
  `trg_sod_bank_accounts_sensitive_change`.
- Reconciliation: `reconcile_bank_transaction_atomic`,
  `reconcile_bank_transfer_atomic`, `unreconcile_bank_transaction`.
- Read projection: `get_bank_transactions_paginated`.
- Feed ingestion: edge function `sync-bank-transactions` (scope-stamping,
  ratcheted by `banking-ownership.test.ts`).
- Governance engine: `approval_route` / `approval_decide` via
  `src/lib/governance/approvalEngine.ts` (ADR-0101).
- Events: `business_event_outbox` + `business_event_topics` — no banking topics
  registered today.

## Business lifecycle (target, server-owned)

`draft → active → suspended → closed` (closure irreversible; reopen only from
suspended). Invariants per transition: activation requires GL link + valid
currency + opening balance settled; suspension blocks new postings and feed
sync but not reconciliation of existing transactions; closure requires zero
unreconciled transactions and no open reconciliation session.

## Defects found (each verified in code)

D1. **Opening balance is browser-orchestrated and failure-silent.**
`BankAccountCreatePage.tsx` inserts the account, then separately calls
`post_journal_entry_atomic`, picking the equity account with a client-side
name heuristic (`name.includes("opening balance")`) and swallowing errors as
`console.warn("non-blocking")`. Result: accounts carrying an
`opening_balance` figure with no journal entry. `ensure_opening_balance_equity_account`
already exists and is not used.

D2. **Currency is a free-text 3-char input** in the create/edit pages, even
though the server registry + trigger define the allowed set. Users hit a raw
`check_violation` instead of choosing from active currencies.

D3. **No server-owned write seam.** `useBankAccounts` does raw
`insert` / `update` / hard `delete` on `bank_accounts` from the browser. No
lifecycle state machine, no optimistic-concurrency token, and delete destroys
an account that may carry transactions and journal history.

D4. **Duplicated financial truth.** `current_balance` is stored on the row and
written from the form, while `Banking.tsx` separately derives a GL-based book
balance. Two numbers, one concept.

D5. **Second ingestion path.** `ImportStatementWizardPage.tsx` inserts
`bank_transactions` / `bank_statements` directly from the browser
(`@ts-nocheck`), bypassing the normalization/dedup/scope logic the feed edge
function applies.

D6. **Feed sync has no idempotency or concurrency control.** The browser sets
`sync_status = 'syncing'` before invoking, and resets it on failure —
concurrent or duplicate syncs are unguarded.

D7. **No banking business events.** Account activation/suspension/closure emit
nothing to `business_event_outbox`, so downstream domains poll state.

## Decisions

- Banking stays a *subledger identity + lifecycle* domain. It owns account
  identity, scope, GL association, lifecycle and opening balance **as an
  accounting event**; it owns no posting, FX, currency, approval or event
  infrastructure.
- All Banking writes move behind SECURITY DEFINER RPCs that re-assert
  authorization via the existing `assert_can_manage_bank_accounts`.
- `current_balance` is demoted to a feed-reported figure (bank balance),
  never the book balance; book balance stays GL-derived.
- No fallback paths: once each RPC lands, the direct-table write is deleted
  from the hook in the same change.

## Work plan

Step 1 — Schema & lifecycle (migration)
- Add `lifecycle_status` (enum `draft|active|suspended|closed`),
  `activated_at`, `closed_at`, `closed_reason`, `opening_balance_je_id`,
  `row_version int not null default 1`, `bank_reported_balance` +
  `bank_balance_as_of`; backfill from `is_active`; keep `is_active` as a
  generated/derived compatibility read until consumers migrate.
- Grants for new/changed surfaces; RLS unchanged (already correct).

Step 2 — Write seam RPCs (migration)
- `bank_account_create(...)` — validates currency against
  `business_active_currencies`, resolves GL account, stamps scope, and posts
  the opening-balance JE **in the same transaction** via
  `post_journal_entry_atomic` + `ensure_opening_balance_equity_account`,
  storing `opening_balance_je_id`. Idempotent on
  `(business_id, provider_id, account_number|external_account_id)`.
- `bank_account_update(...)` — `row_version` check (`40001`-style conflict
  error), immutable fields after first posting (currency, GL account,
  opening balance) once `opening_balance_je_id` exists.
- `bank_account_transition(id, target_status, reason, row_version)` — state
  machine with the invariants above, `SELECT ... FOR UPDATE`, SoD audit,
  and outbox emission.
- Replace hard delete with archive/close; delete permitted only for a `draft`
  account with no transactions.
- Register banking topics in `business_event_topics` and emit
  `banking.account.activated|suspended|closed|opening_balance_posted`
  inside the transaction.

Step 3 — Statement import convergence
- Move CSV/statement persistence into a server function/RPC that reuses the
  same normalization + dedup + scope-stamping contract as the feed path, and
  delete the browser inserts and the `@ts-nocheck`.
- Add an idempotency/advisory-lock guard on sync so duplicate or concurrent
  syncs collapse (fixes D6).

Step 4 — Client seam
- `useBankAccounts` calls only the new RPCs; drop insert/update/delete,
  drop the client-side duplicate pre-check (DB uniques already cover it),
  keep friendly error mapping and extend it to conflict + lifecycle errors.
- Currency becomes a select over the company's base + active currencies.
- Create page loses the opening-balance JE orchestration entirely.
- Banking page presents book balance (GL-derived) and bank-reported balance as
  two labelled, sourced figures; no browser-computed totals beyond FX display
  via `rateBook`.

Step 5 — Tests
- Extend `src/test/architecture/banking-ownership.test.ts` and add a
  banking write-seam ratchet: no direct `from("bank_accounts").insert/update/
  delete` and no `post_journal_entry_atomic` call outside SQL.
- SQL tests under `supabase/tests`: opening-balance atomicity, currency
  rejection, lifecycle transition guards, closure with unreconciled
  transactions, `row_version` conflict, duplicate sync idempotency.
- Realistic multi-branch/multi-currency workflow run (HQ + 2 branches, KES +
  USD accounts, opening balances, payments, transfers, fees, statement import
  with duplicates, reconciliation, reversal).

## Out of scope this wave

Reconciliation UX redesign, Bank Feeds provider expansion, Statements
reporting, and every other Finance domain except where the Banking event
chain above requires it.

## Next coherent step

Step 1 + Step 2 migrations, then migrate the client seam in the same wave.
