# Ledgers & Journals — Reporting Domain Roadmap

Authoritative status file. Update after every implementation.

## Currently active phase

**Phase 7 — Audit gaps. Items 1, 2 and 3 are COMPLETE and now proven against the
live database.** Next agent starts at Phase 8.

## Completed and verified

### Phase 5 / 5A — Unified reporting engine and parity proof
Trial Balance, General Ledger and Journal Report read exactly three server
engines: `get_account_movements`, `get_general_ledger`, `get_journal_report`.
All are `SECURITY DEFINER`, `search_path`-pinned, `anon`-revoked, gated by
`finance_can_read_org`, scoped by organization, business and branch.

### Phase 6 — Multi-currency presentation
`debit` / `credit` are base currency and are the sole authority for every total,
running balance and tie-out. Foreign-currency values are supplementary
(Currency · Document Amt · Rate) and only appear when the run holds a foreign
line. Trial Balance stays base-currency only.

### Phase 7.1 — Drill-through consistency
One resolver (`src/lib/reports/ledgerDrillTarget.ts`) for all three surfaces; a
movement opens its source document when it has one, otherwise its journal entry.
`get_general_ledger` returns `journal_entry_id`; no browser reads journal tables.

### Phase 7.2 — Fiscal-year boundary (PROVEN this pass)
`get_ledger_opening_balances` is the only opening-balance authority; both
`useFinancialReport` and `reportDataEngine` delegate to it with the branch
threaded through. Sections H/I of `supabase/tests/ledger_reports_engine_test.sql`
were executed against the live database inside a self-rolling-back block and all
assertions passed:

- income and expense accounts reset at the fiscal-year start (income opened at 50,
  the current-year movement only; expense at 0),
- prior-years result lands in retained earnings (200),
- balance-sheet accounts carry since inception (cash 250),
- opening debits equal opening credits after the nominal reset,
- nominal accounts open at zero on the first day of the fiscal year,
- `get_general_ledger`'s opening equals the opening engine's.

The fixture required valid `detail_type` values (postable accounts must be
classified); the test file has been corrected accordingly.

### Phase 7.3 — Zero-activity semantics (PROVEN this pass)
Verified in the same run: a zero-activity, zero-opening account is excluded by
default, appears exactly once under `_include_zero_activity`, and an account with
only a brought-forward balance always appears.

### Phase 7.2a — Architecture guard repaired
`src/test/architecture/ledger-reports-single-source.test.ts` now asserts the
delegation-based opening architecture instead of the removed client-side hack.
22 tests pass (17 architecture + 5 resolver).

## Pending

### Phase 8 — Not started
Scheduled ledger deliveries and archive retention review.

## Instructions for the next agent

1. Re-run `npx vitest run src/test/architecture/ledger-reports-single-source.test.ts
   src/test/lib/ledgerDrillTarget.test.ts` (expect 22 passing).
2. To re-execute the SQL suite without `psql`, wrap a section in a migration
   `DO` block that ends with `RAISE EXCEPTION 'LRX_ROLLBACK_OK'` inside an inner
   `BEGIN … EXCEPTION` handler; assertions run, the fixture is discarded.
3. Start Phase 8.

## Scope boundaries

- No new reporting engine, no new report screens, no UI redesign.
- Do not change the posting engine or ADR-0123's posting monopoly.
- Partner Ledger, Consolidation and Control Account Reconciliation stay out of scope.
