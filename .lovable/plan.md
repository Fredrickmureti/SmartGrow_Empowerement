# Finance Wave 1 — Banking Domain Reconstruction (execution ledger)

Seam model:

```text
instruction (UI)        →  seam RPC  →  post_journal_entry_atomic → business_event_outbox
ingestion (CSV / feed)  →  bank_statement_import_batch (single engine)
reconciliation          →  server-owned lifecycle; matches only, never mints payments (ADR 0123)
```

## Phase 1 verification of the previous engineer's claims — RESULT

Re-verified directly against the live database and the codebase, not the ledger.

| Claim | Verdict | Evidence |
|---|---|---|
| Phases 1–2 account lifecycle + write seams | Confirmed | all five `bank_account_*` functions exist, `prosecdef = true` |
| Phase 3 single ingestion engine | Confirmed | `bank_statement_import_batch` / `_fingerprint` / `_apply_rules` present; both callers delegate |
| Phase 4 reconciliation lifecycle, no minting | Confirmed | six seam functions present, GL effects routed to `post_journal_entry_atomic` |
| Phase 4c privilege closure | Confirmed | every banking table ACL is `authenticated=rxtm` only — no INSERT/UPDATE/DELETE, no TRUNCATE, no `anon`/`PUBLIC`; every banking function EXECUTE is `authenticated` + `service_role` only |
| Phase 4d rule authoring seam | Confirmed | upsert/delete RPCs present; no direct table writes in app code |
| Phase 5 currency & FX | Confirmed | import batch rejects rows whose currency ≠ account currency and stamps `original_currency`; `reconcile_bank_transfer_atomic` raises `BANK_TRANSFER_CURRENCY_MISMATCH`; both pages use `CurrencyCombobox` + `useBusinessActiveCurrencies` |
| "Banking suite green (15/15)" | Stale but conservative | actual: 7 files, 40 tests, all passing |

No claim was found false. The ledger understated test coverage; nothing was overstated.

## Defect found during this verification (new, not in the previous ledger)

**D-7 — `bank_accounts.current_balance` is orphaned truth.** The column is
selected and rendered by `useBankAccounts`, but **no database function, trigger
or seam ever writes it** (confirmed: zero `pg_proc` bodies reference it
alongside bank accounts). Every displayed cash figure sourced from it is
unreproducible and cannot be traced by an auditor — a direct §26 provenance
violation. Cash position must derive from canonical state (the GL control
account and/or cleared bank transactions), not from a denormalized column
nobody maintains.

## Remaining work

**Phase 6 — SQL tests (`supabase/tests/`).** One test file per invariant class:
1. Lifecycle: illegal transitions refused; `row_version` conflict raises; draft delete only in draft.
2. Opening balance: posts exactly one JE, idempotent on repeat, refused in a locked period, reset reverses through the engine.
3. Ingestion: concurrent import dedup (same fingerprint → one row), locked period → `rejected_rows`, non-active account refused, currency mismatch rejected.
4. Reconciliation: second open session refused, cross-account line refused, line dated after statement refused, write-off threshold, completion balance gate, cancel keeps provenance.
5. Cross-currency transfer refusal (`BANK_TRANSFER_CURRENCY_MISMATCH`).
6. Privilege ratchet in SQL: assert no `anon`/`PUBLIC` privilege on the banking table/function family (defends against a future `CREATE OR REPLACE` restoring default EXECUTE).

**Phase 7 — cash-position provenance (D-7).**
- Introduce one canonical read: a server-side projection (SQL function or view)
  returning per-account book balance from the GL control account and cleared
  bank movement, with `as_of`.
- Migrate `useBankAccounts` and any dashboard/executive consumer off
  `current_balance`; then drop the column (or make it a generated/derived read)
  so no second source of truth survives — no legacy fallback path.
- Ratchet: no application file reads `current_balance`.

**Phase 8 — ADR + memory.**
ADR documenting the banking write seams (accounts, ingestion, reconciliation,
rule authoring), the ADR-0123 no-mint property, the currency-integrity rule,
and the single cash-position projection. Update `mem/features/banking-domain.md`.

**Phase 9 — closing sweep.** Re-run the banking suite + typecheck, then re-query
`pg_proc.proacl` and `pg_class.relacl` for the whole banking family after every
Phase 6–8 redefinition.

## Explicitly out of scope for this wave

AP/AR, fixed assets, budgets, reporting redesign. Banking dependencies
(currency, FX, COA, posting engine, fiscal periods, events) are followed only as
far as Banking's correctness requires; all of them already have canonical
engines and are consumed, not duplicated.

## Next coherent step

Phase 6.1–6.3 (lifecycle, opening balance, ingestion SQL tests).
