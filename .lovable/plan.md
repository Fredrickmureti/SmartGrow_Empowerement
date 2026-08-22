# Financial Statements — Execution Status & Roadmap

Authoritative status file. Evidence labels: **[VF]** verified fact · **[AP]** accounting
principle · **[UV]** unverified. Full audit findings live in
`.lovable/plan/financial-statements-p-l-balance-sheet-audit-findings-execut-2026-08-22.md`.

## Currently active phase

**Phase T (test coverage for A–D) — active, nothing written yet.**
Phases A, B, C and D are code complete and live-DB verified. The Balance Sheet
equity presentation (current-year earnings and prior-years result as explicit
lines) has also landed on the screen — that was the last code change. The one
thing standing between A–D and sign-off is automated tests (see "Tests
required"). No new feature work starts before those exist.


## Phase status

| Phase | Scope | Status |
|---|---|---|
| A | Business-level authorization on every statement path | Implemented, live-DB verified, tests pending |
| B | One retained-earnings authority in SQL | Implemented, live-DB verified, tests pending |
| C | Server/screen statement convergence | Implemented, parity test pending |
| D | Hierarchy correctness (parent own-postings) | Implemented, unit test pending |
| T | Automated test coverage for A–D | **ACTIVE — not started** |
| E | Classification hygiene (`detail_type` backfill, warnings) | Not started |
| F | Presentation (Statement of Changes in Equity, masthead) | Partial — equity split lines shipped on the Balance Sheet screen; SoCE and masthead not started |


## What is fully implemented

### Phase A — authorization [VF]
- New `public.finance_can_read_scope(_org_id, _business_id)`: org membership **and**
  `user_can_access_business`. When `_business_id IS NULL` (org-wide run) it demands
  access to **every** active business in the org, so an unscoped aggregate can never
  include a business the caller is not entitled to. `service_role` short-circuits.
  `EXECUTE` revoked from `PUBLIC`/`anon`.
- `get_account_movements`, `get_ledger_opening_balances`, `get_general_ledger`,
  `get_journal_report` now gate on it instead of `finance_can_read_org`. Verified in
  `pg_get_functiondef` for all four. [VF]
- `render-report` edge function: after org-membership it evaluates
  `finance_can_read_scope` **as the caller** (anon key + caller JWT), never with the
  service-role client, before any builder runs.

### Phase B — retained earnings [VF]
- New `public.get_equity_result(_org, _business, _as_of, _branch)` returns
  `fiscal_year_start`, `current_year_earnings`, `prior_years_result`,
  `retained_earnings_account_id`, using the same fiscal calendar and the same
  retained-earnings resolution as `get_ledger_opening_balances`.
- `useFinancialReport` no longer sums income/expense since `1900-01-01`. It adds only
  the **current** fiscal year's result; closed years remain inside the retained-earnings
  account's opening balance. The prior-year double count (B1) is gone.
- `reportDataEngine.buildBalanceSheet` consumes the same RPC instead of deriving its
  own figure, so screen and PDF cannot disagree (B2).
- Live-ledger check after the change: assets 95,840 = liabilities −5,010 +
  equity accounts 100,400 + current-year earnings 450. Balances exactly. [VF]

### Phase C — server/screen convergence [VF]
- `buildIncomeStatement` rebuilt as the screen's multi-step statement: Revenue −
  Cost of sales = Gross profit → − Operating expenses = Operating profit → + Other
  income − Other expenses = Profit before tax → − Tax = **Net profit**, with exactly
  one grand total (P3 fixed).
- `branchId` threaded into `buildIncomeStatement` and into both callers
  (`render-report`, `process-scheduled-reports`) — a branch-scoped scheduled P&L no
  longer returns whole-business figures (P2 fixed).
- Balance Sheet remains entity-level on both sides, matching
  `src/lib/reports/branchScopability.ts` (`balance_sheet: false`). [AP] A branch is
  not a legal entity and holds no equity.

### Phase D — hierarchy [VF]
- `buildAccountHierarchy` now rolls children **up into** the parent's own figures
  instead of overwriting them.
- `useFinancialReport` section totals sum every account's **own** amount exactly once;
  group rows additionally carry `rollup_amount` for presentation only. A parent that
  carries its own postings is no longer excluded from the section total, and nothing
  is double counted.

### Balance Sheet equity presentation [VF]
- `FinancialReports.tsx` renders equity as: equity accounts (which already carry every
  **closed** year's result via the SQL opening balances), then an explicit
  "Current year earnings" line from `balanceSheetTotals.currentYearEarnings`, then a
  "Prior years result" line when non-zero, then Total equity and Total liabilities and
  equity. No client-side re-derivation of either figure.

## What is still pending

1. **Tests** (blocking sign-off on A–D) — see below.
2. **Phase E — classification hygiene.** 18 active accounts still have
   `detail_type IS NULL` and are classified by code range alone; no report-level
   warning is raised, and no diagnostic fires when no retained-earnings account
   resolves (the UI now shows an inline line for this case, but SQL still drops the
   prior-year result silently).
3. **Phase F — presentation.** Statement of Changes in Equity; masthead stating basis,
   currency and reporting scope.

## Tests required (none written yet) [UV]

- SQL `supabase/tests/financial_statements_test.sql`: prior-year profit appears once;
  no-history business; reversal; backdated posting; fiscal-year rollover; missing
  retained-earnings account; branch-scoped P&L excludes other branches; **a member of
  the org without `user_business_access` is denied on all four RPCs**.
- Vitest: screen-vs-`reportDataEngine` parity snapshot for both statements; hierarchy
  totals with a parent that carries its own postings; zero-activity behaviour.
- Runtime: two-user cross-business probe against the RPCs and `render-report`.

Current suite state: `bunx vitest run src/services/reports src/hooks` → 173 passed,
3 failed. The 3 failures are in `src/hooks/pos/__tests__/posScopeContaminationGuard.test.ts`
and are POS-scope assertions unrelated to this work; **confirm they are pre-existing
before treating them as such.** [UV]

## Invariants that must hold after every phase

1. Assets = Liabilities + Equity, with prior-year result counted exactly once and the
   current-year result exactly once.
2. Screen figure == scheduled-PDF figure for the same org/business/branch/date.
3. P&L net profit == the Balance Sheet's current-year-earnings line for the same
   fiscal year to the same date.
4. No statement number is produced for a business the caller cannot access.
5. Every amount in a section total comes from exactly one account row.
6. No second reporting engine, no client-side ledger aggregation, no FX in the browser.

## Scope boundaries

No FX translation work; no changes to the posting engine; Trial Balance, GL, Journal
Report, Partner Ledger, Cash Flow and Consolidation are out of scope except where a
shared function must change.

## Instructions for the next agent

1. **Verify before you build.** Do not start Phase E until you have independently
   confirmed Phases A–D:
   - Re-read `pg_get_functiondef` for the four RPCs and `finance_can_read_scope`;
     confirm the org-wide (`_business_id IS NULL`) branch really denies a partial-access
     member.
   - Confirm `render-report` cannot be reached with a `businessId` outside the caller's
     access, including the service-role/cron path.
   - Re-run the balance equation against live data and confirm invariant 3 by comparing
     the P&L net profit with `get_equity_result.current_year_earnings`.
   - Diff the screen statement against `reportDataEngine` output for one business.
2. **Then write the tests listed above** — Phases A–D are not signed off without them.
   That is the next milestone, ahead of any new feature work.
3. **Only then start Phase E**, followed by Phase F. Keep execution chronological;
   finish each phase to a production-ready state before the next.

## Execution status

Phases A–D implemented and verified against live data; automated tests outstanding.
Next milestone: test coverage for A–D, then Phase E.
