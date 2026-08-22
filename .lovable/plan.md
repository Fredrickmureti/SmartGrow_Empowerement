# Ledgers & Journals — Reporting Domain Roadmap

Authoritative status file. Update after every implementation.

## Currently active phase

**Phase 7 — Audit gaps. Item 1 (drill-down consistency) is COMPLETE.**
Next agent starts at Phase 7, item 2 (fiscal-year boundary behaviour).

## Completed and verified

### Phase 5 / 5A — Unified reporting engine and parity proof
- Trial Balance, General Ledger and Journal Report read exactly three server
  engines: `get_account_movements`, `get_general_ledger`, `get_journal_report`.
- All three are `SECURITY DEFINER`, `search_path`-pinned, `anon`-revoked, gated
  by `finance_can_read_org`, scoped by organization, business and branch.
- Guards: `supabase/tests/ledger_reports_engine_test.sql`,
  `src/test/architecture/ledger-reports-single-source.test.ts`.

### Phase 6 — Multi-currency presentation
- `debit` / `credit` are base currency and are the sole authority for every
  total, running balance and tie-out. Foreign-currency values are a supplement
  (Currency · Document Amt · Rate) shown only when the run holds a foreign line,
  on screen and in PDF/CSV/XLSX. Trial Balance gains no FX columns.
- Rule mirrored in `src/lib/reports/currencyPresentation.ts` and
  `supabase/functions/_shared/reports/currencyPresentation.ts`.

### Phase 7.1 — Drill-through consistency (COMPLETE)
One rule for all three ledger surfaces:
> A movement drills into its source document when it has one; otherwise into
> the journal entry that created it. The engine supplies the identifiers; the
> browser never reads journal tables to find them.

- `get_general_ledger` now returns `journal_entry_id` (migration applied), and
  the SQL suite fails if that column disappears.
- `src/lib/reports/ledgerDrillTarget.ts` is the single resolver, used by
  General Ledger, Journal Report and the Trial Balance drill-down dialog.
- Removed the browser-side `journal_entry_lines` lookups from
  `GeneralLedger.tsx` and `DrillDownDialog.tsx`.
- Trial Balance drill-down now inherits the report's `branchId`; previously a
  branch-scoped figure opened an all-branch transaction list.
- Tests: 17 architecture assertions + 5 resolver unit tests, all passing.

## Pending

### Phase 7 — Remaining items
2. **Fiscal-year boundary behaviour** — opening balances at a fiscal-year start
   must respect year-end closing entries; verify and cover with SQL tests.
3. **Zero-balance / zero-activity accounts** — `_include_zero_activity`
   semantics must match between screen, PDF and Trial Balance.

### Phase 8 — Not started
Scheduled ledger deliveries and archive retention review.

## Instructions for the next agent

1. Re-run `npx vitest run src/test/architecture/ledger-reports-single-source.test.ts
   src/test/lib/ledgerDrillTarget.test.ts` (expect 22 passing) and execute
   `supabase/tests/ledger_reports_engine_test.sql`.
2. Resume at Phase 7, item 2. Bring each item to a production-ready state —
   schema, engine, screen, export and tests — before moving to the next.
