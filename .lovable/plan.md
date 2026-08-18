# Banking Domain Reconstruction — Authoritative Status

Wave: Finance → Banking (multi-tenant, multi-branch, country-agnostic).
Target architecture: one server-owned write seam per concern.

```text
instruction (UI)        →  seam RPC  →  post_journal_entry_atomic
                                     →  business_event_outbox
ingestion (CSV / feed)  →  ONE normalization + dedup engine  →  bank_transactions
reconciliation          →  matches only, never mints payments (ADR 0123)
```

---

## Phase 1 — Account schema, lifecycle & provenance — VERIFIED DONE

Independently confirmed in the live database:
`bank_account_lifecycle_status` enum exists; `bank_accounts` carries
`lifecycle_status`, `activated_at`, `closed_at`, `closed_reason`,
`opening_balance_je_id`, `row_version`, `bank_reported_balance`,
`bank_balance_as_of`; trigger `_bank_account_derive_state` derives `is_active`
and `is_shared` and bumps `row_version` on every update. Book balance and
bank-reported balance are separate facts.

## Phase 2 — Server-owned account write seam — VERIFIED DONE (with gaps, below)

Confirmed present and `SECURITY DEFINER`: `bank_account_create`,
`bank_account_update`, `bank_account_transition`, `bank_account_delete_draft`,
`bank_account_reset_opening_balances`.

Confirmed: `authenticated` holds only `SELECT/references/trigger` on
`bank_accounts` — INSERT/UPDATE/DELETE are revoked, so the seam is a real
monopoly. Opening balance posts through `_bank_account_post_opening_balance`,
which calls `post_journal_entry_atomic` in the same transaction, is idempotent
via `opening_balance_je_id`, refuses accounts with no GL link, and publishes
`banking.account.opening_balance_posted`. (Correction to the prior log:
`bank_account_create` does not call the posting engine directly — it delegates
to that helper. Substantively as claimed.)

Ratchets `banking-write-seam.test.ts` + `banking-ownership.test.ts`: 12/12 pass.
Repo scan: zero `.from("bank_accounts").insert/update/delete` in app code.

### New defects found during verification (were NOT in the prior plan)

- **D-A — the `anon` role holds full write privileges** (`arwdDxtm`) on
  `bank_accounts`, `bank_transactions` and `bank_statements`. Phase 2 revoked
  `authenticated` only. RLS is currently the sole barrier on financial tables
  for unauthenticated callers; the grant itself must go.
- **D-B — every banking seam RPC is `EXECUTE`-able by `PUBLIC` and `anon`.**
  These are `SECURITY DEFINER` mutators. Compare
  `reconcile_bank_transfer_atomic`, which is correctly scoped to
  `authenticated`/`service_role`. Same treatment required.
- **D-C — ingestion has no lifecycle or fiscal-period gate** on either path.
- **D-D — statement import is not atomic.** The wizard inserts a
  `bank_statements` row with `status: 'processing'`, then batch-upserts rows in
  50-row chunks; any mid-batch failure leaves a stuck statement plus partial
  transactions, and the browser then reports its own success/duplicate counts.
- **D-E — dedup identity is computed in the browser** (`generateTransactionHash`,
  a 64-bit FNV-1a variant in `src/lib/bankStatementParsers/index.ts`). The
  client chooses the value that the `(bank_account_id, external_transaction_id)`
  unique constraint keys on, so duplicate suppression is client-controlled.

---

## ACTIVE PHASE → Phase 3 — Statement ingestion convergence

Confirmed duplication: the wizard
(`src/features/finance/banking/import/ImportStatementWizardPage.tsx:197-360`)
parses, hashes, dedups, inserts the statement, batch-upserts transactions,
applies categorization rules and stamps statement status entirely in the
browser; `supabase/functions/sync-bank-transactions/index.ts:760` inserts
canonical transactions through its own path. `bank_statement_import_batch`
does not exist yet.

Work items, in order:

1. `bank_statement_import_batch(_bank_account_id, _statement jsonb, _rows jsonb, _request_id text)`
   — `SECURITY DEFINER`, one transaction, owning: account lookup + scope
   stamping from the parent account, **server-side** row-hash derivation,
   dedup against the unique key, rule application, statement upsert (keyed on
   `file_hash` so a retry updates rather than duplicates), final statement
   status, and a `banking.statement.imported` business event. Refuses
   non-`active` accounts and locked fiscal periods.
2. Move hash derivation into SQL as the single authority; the browser hash
   becomes preview-only (or is deleted if nothing else needs it).
3. Make `sync-bank-transactions` delegate its transaction write to the same RPC
   so hash and dedup semantics cannot drift.
4. Reduce the wizard to parse → map → preview → one RPC call, and render the
   RPC's own ingested / duplicate / rejected counts.
5. Revoke `INSERT/UPDATE/DELETE` on `bank_transactions` and `bank_statements`
   from `authenticated` once no client path writes them; fix **D-A** and
   **D-B** in the same migration.
6. Extend `banking-write-seam.test.ts` with a no-direct-write scan for
   `bank_transactions` / `bank_statements` and an assertion that both ingestion
   paths call the one engine.

## Phase 4 — Reconciliation boundary hardening (PENDING)

Prove reconciliation only matches existing payments or delegates to
`record_multi_invoice_payment` / `record_multi_bill_payment`, never mints them
(ADR 0123 §3). Audit `useReconciliationItems`, `bank_reconciliation_matches`
and the writeoff paths for direct GL writes; ratchet the result.

## Phase 5 — Currency & FX correctness in Banking (PENDING)

Replace the free-text currency input with a `business_active_currencies`-backed
selector; confirm every banking money display resolves through
`@/services/fx/rateBook` (missing rate → `—`, never 1:1).

## Phase 6 — SQL tests + documentation (PENDING)

`supabase/tests/` coverage for lifecycle guards, opening-balance atomicity and
idempotency, row-version conflicts, close refusal, and ingestion dedup under
concurrent imports. Then an ADR for the single bank-account write seam and a
`mem://features/banking-write-seam` entry.

---

## Instructions for the next agent

Phases 1–2 are verified — do not re-litigate them. Resume at Phase 3 and carry
it to a production-ready state (RPC + edge delegation + wizard reduced to
preview + grants fixed including D-A/D-B + ratchet) before touching Phase 4–6.
Update this ledger at the end of every phase.
