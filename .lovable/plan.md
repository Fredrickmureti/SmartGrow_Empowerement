# Banking Domain Reconstruction — Authoritative Status

Domain: Enterprise Finance → Banking (multi-tenant, multi-branch, country-agnostic).
Verdict from the audit: the domain was *data-capable* but not *architecturally
trustworthy* — account mutations were browser-orchestrated, opening balances were
posted in a second round trip (non-atomic), lifecycle was a boolean, there was no
concurrency control, and statement ingestion existed twice (browser CSV import and
the sync edge function) with two copies of normalization/dedup logic.

Target architecture: one server-owned write seam per concern.

```text
instruction (UI)  →  write seam RPC  →  posting engine (post_journal_entry_atomic)
                                     →  business_event_outbox
ingestion (CSV / feed)  →  one normalization + dedup engine  →  bank_transactions
reconciliation  →  matches only, never mints payments (ADR 0123)
```

---

## Phase 1 — Account schema, lifecycle & provenance — DONE (verified)

- `bank_account_lifecycle_status` enum: `draft | active | suspended | closed`.
- `bank_accounts` gained `lifecycle_status`, `activated_at`, `closed_at`,
  `closed_reason`, `opening_balance_je_id`, `row_version`,
  `bank_reported_balance`, `bank_balance_as_of`.
- Legacy `is_active` / balance columns backfilled; trigger
  `aa_bank_account_derive_state` derives `is_active` and `is_shared`
  (`is_shared ⇔ branch_id IS NULL`) and increments `row_version` on update.
- Book balance vs bank-reported balance are now separate facts.

Verified: migration applied, columns/enum present, generated Supabase types
include the new fields, typecheck clean.

## Phase 2 — Server-owned write seam (monopoly) — DONE (verified)

SECURITY DEFINER RPCs, the only permitted mutators:

| RPC | Owns |
| --- | --- |
| `bank_account_create` | creation, currency normalization/validation, advisory lock against duplicate connections, atomic opening-balance posting |
| `bank_account_update` | field updates, optimistic concurrency via `_row_version`, accounting immutability once history exists |
| `bank_account_transition` | lifecycle changes + guards (refuses close with unreconciled txns / open reconciliation session) |
| `bank_account_delete_draft` | delete only untouched drafts |
| `bank_account_reset_opening_balances` | migration reset that *voids* the JE instead of orphaning it |

- Opening balance posts through `post_journal_entry_atomic` in the **same
  transaction** as the account row (ADR 0123 respected — no raw journal inserts).
- `INSERT/UPDATE/DELETE` on `public.bank_accounts` revoked from `authenticated`.
- `banking.account` topic registered in `business_event_topics`;
  `banking.account.*` events emitted from the seam.

Client convergence (all verified by typecheck + tests):
`useBankAccounts` (RPC-only, exposes `transitionAccount`, maps
`BANK_ACCOUNT_ALREADY_CONNECTED` / `BANK_ACCOUNT_VERSION_CONFLICT` hints),
`BankAccountCreatePage` (no browser JE orchestration), `BankAccountEditPage`
(row-versioned updates + transitions), `BranchOperations`,
`BranchScopedSettings`, `MigrationStepBankBalances`, `useMigrationSession`.
Sync status is written only by `supabase/functions/sync-bank-transactions`.

Ratchets: `src/test/architecture/banking-write-seam.test.ts` (5 tests, incl. a
repo-wide scan for direct `bank_accounts` writes) and updated
`banking-ownership.test.ts` — 12/12 passing.

Known pre-existing, unrelated failure: `business-scoped-queries.test.ts`
(51 offenders across 35 non-banking files). Not introduced by this wave.

---

## ACTIVE PHASE → Phase 3 — Statement ingestion convergence (NOT STARTED)

One ingestion engine for both manual CSV import and automated feeds.

Current duplication:
- `src/features/finance/banking/import/ImportStatementWizardPage.tsx:160-360`
  parses, hashes (`generateTransactionHash` from
  `src/lib/bankStatementParsers/index.ts:251`), dedups, batch-inserts into
  `bank_transactions`, and applies categorization rules **in the browser**.
- `supabase/functions/sync-bank-transactions/index.ts` does the same work
  server-side with its own dedup and scope stamping (R7).

Work items:
1. Server-owned ingestion RPC (e.g. `bank_statement_import_batch`) taking a
   normalized row array + `bank_statement_id`, performing hash dedup, scope
   stamping from the parent account, and rule application in one transaction.
   Must refuse ingestion into non-`active` accounts and into locked fiscal periods.
2. Make the edge function delegate to the same RPC so hash/dedup semantics
   cannot drift.
3. Reduce the wizard to parse + preview + call the RPC; revoke
   `bank_transactions` INSERT from `authenticated` once no client path inserts.
4. Report ingested / skipped-duplicate / rejected counts back to the wizard UI.
5. Ratchet: extend `banking-write-seam.test.ts` with a no-direct-
   `bank_transactions`-insert scan, plus a test that both paths call one engine.

## Phase 4 — Reconciliation boundary hardening (PENDING)

Assert (and test) that reconciliation only matches existing payments or delegates
to `record_multi_invoice_payment` / `record_multi_bill_payment`, never mints
payments (ADR 0123 §3). Audit `useReconciliationItems`,
`bank_reconciliation_matches`, and writeoff paths for direct GL writes.

## Phase 5 — Currency & FX correctness in Banking (PENDING)

Replace the free-text currency input with the registry-backed selector
(`business_active_currencies`), and confirm every banking money display goes
through `@/services/fx/rateBook` (missing rate → `—`, never 1:1).

## Phase 6 — SQL-level tests + documentation (PENDING)

`supabase/tests/` coverage for lifecycle guards, opening-balance atomicity,
row-version conflicts, and close refusal; then an ADR recording the
"single bank-account write seam" decision and a `mem://features/banking-write-seam`
memory entry.

---

## Instructions for the next agent

1. **Verify Phases 1–2 before writing new code.** Do not trust this document alone.
   - `npx vitest run src/test/architecture/banking-write-seam.test.ts src/test/architecture/banking-ownership.test.ts` → must be 12/12.
   - Confirm grants: `bank_accounts` must have no `INSERT/UPDATE/DELETE` for
     `authenticated` (`information_schema.role_table_grants`).
   - Confirm the seam RPCs exist with `security definer` and that
     `bank_account_create` posts the opening balance through
     `post_journal_entry_atomic` (no raw journal inserts anywhere).
   - Grep `src` for any `.from("bank_accounts").insert/update/delete` — must be zero.
   - Typecheck must be clean (`tsgo`).
2. **Then resume at Phase 3 (statement ingestion convergence)** — do not start
   Phase 4/5/6 or unrelated domains first. Bring Phase 3 to a production-ready
   state (server RPC + edge delegation + wizard reduced to preview + grants
   revoked + ratchet) before moving on.
3. Update this file at the end of every phase: what is implemented and verified,
   what is pending, which phase is active, what comes next.
