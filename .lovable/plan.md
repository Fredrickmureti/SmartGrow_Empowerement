# Finance Wave 1 — Banking Domain Reconstruction (authoritative status)

Seam model:

```text
instruction (UI)        →  seam RPC  →  post_journal_entry_atomic → business_event_outbox
ingestion (CSV / feed)  →  bank_statement_import_batch (single engine)
reconciliation          →  server-owned lifecycle; matches only, never mints payments (ADR 0123)
cash position           →  bank_account_positions(business, as_of) — derived, never stored
```

## Fully implemented and verified

- **Phases 1–2 — account lifecycle + write seams.** Five `bank_account_*` SECURITY DEFINER seams, pinned `search_path`, `row_version` optimistic concurrency.
- **Phase 3 — single ingestion engine.** `bank_statement_import_batch` (+ `_fingerprint`, `_apply_rules`); CSV and feed both delegate; dedup via `ON CONFLICT (bank_account_id, external_transaction_id)`.
- **Phase 4 — reconciliation lifecycle.** Six seams; no payment minting (ADR-0123); GL effects only via `post_journal_entry_atomic`.
- **Phase 4c/4d — privilege closure + rule authoring seam.** `authenticated` is read-only on every banking table; no `anon`/`PUBLIC` execute.
- **Phase 5 — currency & FX integrity.** Import rejects foreign-currency lines; `BANK_TRANSFER_CURRENCY_MISMATCH` on cross-currency transfers.
- **Phase 7 — cash-position provenance (D-7 closed).** `bank_account_positions(uuid, date)` SECURITY INVOKER projection; `bank_accounts.current_balance` dropped; all UI/analytics consumers migrated; `src/test/architecture/banking-balance-provenance.test.ts` ratchets it. Banking architecture suite 44/44 green + typecheck clean.
- **D-8 closed.** `bank_account_create(activate=true)` now requires a linked GL account and does not post an opening balance for drafts.
- **Journal posting monopoly.** `anon` privileges revoked on `journal_entries` / `journal_entry_lines`.

## Phase 6 — SQL invariant tests (ACTIVE, largely delivered)

New pgTAP-style files in `supabase/tests/` (catalog + routine-definition assertions, so they cannot be satisfied by comments and survive `CREATE OR REPLACE`):

- `bank_account_lifecycle_invariants_test.sql` — enum closure, one hardened overload per seam, illegal transitions, `row_version` conflict, D-8 activation guard, opening balance routed through the posting engine, draft-only delete.
- `bank_statement_ingestion_invariants_test.sql` — single engine, deterministic non-clock fingerprint, DB-level dedup index, active-account / currency / locked-period / rejected-rows guards, no second insert path into `bank_transactions`.
- `bank_reconciliation_lifecycle_invariants_test.sql` — six hardened seams, scope / after-statement / closed-session / write-off bound / balanced-completion guards, cancel preserves provenance, ADR-0123 no-mint proof, single open session index, cross-currency transfer refusal.
- `banking_privilege_ratchet_test.sql` — no write privilege for `authenticated`, no `anon`/`PUBLIC` anywhere, RLS on all banking tables, journal tables closed to `anon`, D-7 ratchet (`current_balance` stays dropped, `bank_account_positions` stays SECURITY INVOKER).

### Defect found during Phase 6

**D-9 — concurrent reconciliation starts.** "One open session per account" was a read-then-write `EXISTS` check with no index behind it; two concurrent starts could both win, and the error hint referenced an index that did not exist.

Fix authored as a migration: partial unique index `bank_reconciliation_one_open_per_account` on `(bank_account_id) WHERE status = 'in_progress'`, older duplicate open sessions auto-cancelled (provenance kept), and `bank_reconciliation_session_start` re-emitted so the race collapses into the domain error `BANK_RECON_SESSION_OPEN` instead of a raw unique violation.

**Status of that migration: UNCONFIRMED.** The Supabase SQL endpoint began timing out (HTTP 524/544) mid-apply; the outcome could not be read back. This is the single open item in Phase 6.

## Pending

1. **Phase 6 closure (next action).** Verify D-9: does `bank_reconciliation_one_open_per_account` exist and does `bank_reconciliation_session_start` contain `BANK_RECON_SESSION_OPEN`? If not, re-apply the migration (it is idempotent: `CREATE UNIQUE INDEX IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION`). Then execute the four new SQL test files against the linked database and fix any drift they expose.
2. **Phase 8 — ADR + memory.** ADR covering all banking write seams, the ADR-0123 no-mint property, currency integrity, the single cash-position projection and the D-9 concurrency invariant; refresh `mem/features/banking-domain.md`.
3. **Phase 9 — closing sweep.** Re-query `pg_proc.proacl` / `pg_class.relacl` for the whole banking family after every Phase 6–8 redefinition; re-run the banking architecture suite + typecheck.

Out of scope for this wave: AP/AR, fixed assets, budgets, reporting redesign.

## Instructions for the next agent

1. **Verify before building.** Confirm against the live database (not this document): the D-9 index and the `BANK_RECON_SESSION_OPEN` guard, the four new test files pass, `bank_accounts.current_balance` is still absent, `bank_account_positions` is still SECURITY INVOKER, and no banking table/routine has regained `anon`/`PUBLIC` privileges.
2. **Then resume chronologically** at Phase 6 closure → Phase 8 → Phase 9. Do not start unrelated finance areas while Phase 6 has an unconfirmed migration.
3. Keep every phase production-ready before advancing: no partial seams, no orphaned columns, no UI reading a value the server does not own.
