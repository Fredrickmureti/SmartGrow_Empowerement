# Ledgers & Journals — Reporting Domain Roadmap

Authoritative status file. Update after every implementation.

## Currently active phase

**Phase 7 — Audit gaps. Verification of Phases 5/5A/6 is done (see below); Phase 7
item 1 is the next thing to build.**

## Verification pass (this session, independent of the previous engineer's notes)

Confirmed directly against the database and codebase:

- `get_account_movements`, `get_general_ledger`, `get_journal_report` and
  `finance_partner_ledger` all exist, are `SECURITY DEFINER`, `search_path`-pinned
  and gated by `finance_can_read_org`. `get_general_ledger` and
  `get_journal_report` additionally validate business/branch ownership.
- Phase 6 is real: `get_general_ledger` and `get_journal_report` return
  `original_debit`, `original_credit`, `exchange_rate`; both runtimes carry the
  shared presentation rule (`src/lib/reports/currencyPresentation.ts` and
  `supabase/functions/_shared/reports/currencyPresentation.ts`).
- `src/test/architecture/ledger-reports-single-source.test.ts` passes, 13 tests.
- Branch scoping in `get_general_ledger` is strict, and `accounts.opening_balance`
  is correctly suppressed (`CASE WHEN _branch_id IS NULL`) on branch-scoped runs.

So Phases 5, 5A and 6 stand as completed. Nothing needs redoing there.

## Phase 7 — Audit gaps (defects confirmed this pass)

### 7.1 Drill-through is three different implementations (NEXT)

Verified:
- General Ledger holds its own `openSource()` which, when a line has no
  `source_type`/`source_id`, **queries `journal_entry_lines` directly from the
  browser** to resolve the journal entry id. That is a raw ledger-table read on a
  reporting screen and the only reason it exists is that `get_general_ledger`
  does not return `journal_entry_id`.
- Journal Report has a second, near-identical `openEntryDrawer()` with slightly
  different rules (it special-cases `source_type = 'manual'`; GL does not).
- Trial Balance drills through `DrillDownDialog`, which calls
  `get_general_ledger` **without `_branch_id`** — a branch-scoped Trial Balance
  therefore drills into all-branch lines. This is a scoping defect, not a
  cosmetic inconsistency.

Work:
1. Migration: add `journal_entry_id` to the `get_general_ledger` result so the
   engine, not the browser, resolves the entry behind a line.
2. One shared resolver (`src/lib/reports/ledgerDrillTarget.ts`): given
   `{ source_type, source_id, journal_entry_id }` return the preview target,
   with `manual`/null handled once. GL, Journal Report and `DrillDownDialog`
   all call it; delete both local copies and the raw `journal_entry_lines` read.
3. Thread `branchId` through `DrillDownConfig` into the `get_general_ledger`
   call so Trial Balance drill-down inherits the report's branch scope.
4. Tests: extend `ledger-reports-single-source.test.ts` to forbid direct
   `journal_entry_lines` / `journal_entries` reads anywhere under
   `src/pages/reports/` and `src/components/reports/`, and to assert the three
   screens import the shared resolver. Add a unit test for the resolver's
   manual / source-backed / missing-source branches.

### 7.2 Fiscal-year boundary behaviour

`get_general_ledger`'s opening balance is `accounts.opening_balance` plus all
visible prior-dated movement. Whether year-end closing entries make P&L accounts
open at zero in a new fiscal year is currently untested. Add cases to
`supabase/tests/ledger_reports_engine_test.sql`: a closing entry dated on the
fiscal-year end must leave income/expense accounts with a zero opening balance in
the following year, and must not double-count retained earnings in the balance
sheet accounts.

### 7.3 Zero-activity / zero-balance semantics

`get_general_ledger` emits an account when `_include_zero_activity` is true, or
it has lines, or a non-zero opening. Pin that exact rule with SQL tests and
assert Trial Balance's `includeZeroBalances` toggle and the PDF path agree with
the screen.

## Phase 8 — Not started

Scheduled ledger deliveries and archive retention review.

## Scope boundaries

- No new reporting engine, no new report screens, no UI redesign.
- Do not change the posting engine or ADR-0123's posting monopoly.
- Partner Ledger, Consolidation and Control Account Reconciliation stay out of
  scope this wave.
