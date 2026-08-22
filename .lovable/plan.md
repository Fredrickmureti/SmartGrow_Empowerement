# Financial Statements — Architecture & Accounting Integrity

Authoritative status. Updated 2026-08-22.

## Currently active phase

Phase E (classification / chart hygiene) — **complete**. Next active work is
Phase F (comparatives) then Phase G (SQL isolation tests).

## Fully implemented and verified

### Phase A/B — authorization and fiscal anchoring (inherited, re-verified)
- Reporting RPCs gate on `finance_can_read_branch` / `finance_can_read_financials` /
  `finance_can_read_scope`.
- Balance-sheet windows anchor to the fiscal-year start so closed years' result
  stays in equity. Pinned by `src/test/architecture/report-statement-snapshot.test.ts`.

### Phase C — one branch-scope rule (this wave)
- Registry moved to `supabase/functions/_shared/reports/branchScopability.ts`;
  `src/lib/reports/branchScopability.ts` re-exports it (presentation copy for the
  entity-only rationale stays browser-side). Copies can no longer drift.
- `scopeBranchForReport()` is the gate. `render-report/index.ts#buildReportData`
  and `process-scheduled-reports#resolveScheduleBranch` both call it, so a stored
  schedule or an API caller can no longer obtain a branch-sliced Balance Sheet,
  Trial Balance or Cash Flow that the screen refuses to render.
- Verified by `src/test/architecture/report-branch-scope-parity.test.ts` (6 tests).

### Phase D — hierarchy correctness and footing (this wave)
- `FinancialReports.tsx#classifyAccounts` no longer drops `is_group` rows. A
  posted parent is a visible row, not a hidden contributor to the section total.
- `useFinancialReport.ts` hierarchy pass now sets depth/grouping only; the unused
  `rollup_amount` path is gone, so parent/child can never double count.
- Verified by `src/test/architecture/statement-row-footing.test.ts`: revenue
  subtotal equals the sum of its rendered rows (1,000 own + 6,000 + 9,000 detail,
  not a rolled-up 19,000), plus a source guard against the `!a.is_group` filter.

### Phase E — deactivated accounts keep their balance (this wave)
- `useFinancialReport.ts#fetchAccounts` and
  `reportDataEngine.ts#getGLAccountBalances` no longer filter `is_active = true`.
  Deactivation is chart hygiene, not settlement; the row used to vanish while the
  equity/result RPCs still counted its movement, so the statement stopped
  balancing. Empty accounts are still suppressed by the existing zero-activity /
  `closing_balance === 0` rules, so the chart stays clean.
- Verified by `src/test/architecture/statement-inactive-accounts.test.ts`: a
  closed bank account holding 2,500 is presented and the sheet balances; a
  deactivated empty account stays off the statement; source guard forbids
  re-adding an `is_active` filter to either account query.

Verification run this wave: `tsgo --noEmit -p tsconfig.app.json` clean; the five
reporting architecture test files pass (18 tests).

## Pending

### Phase F — comparatives (NEXT)
- `useFinancialReport` computes `comparison_amount` / `variance` /
  `variance_percent`, but the server engine (`reportDataEngine`) has no
  comparative path, so the on-screen comparative statement has no PDF/CSV
  equivalent. Decide: build comparatives server-side (preferred — one document
  on screen and on paper) or hide the comparative toggle from exportable
  statements. Do not leave the current asymmetry.
- Comparative P&L must reuse the fiscal-year anchoring of the primary window.

### Phase G — branch/business isolation SQL tests
- Add pgTAP-style tests under `supabase/tests/` asserting that
  `get_account_movements`, `get_ledger_opening_balances` and `get_equity_result`
  return nothing for a caller outside the organization/branch, and that a
  branch-restricted user cannot read consolidated figures.

### Phase H — currency presentation
- Confirm statements state their presentation currency and that multi-currency
  businesses cannot silently sum mixed-currency accounts.

### Known baseline (not caused by this wave)
- `bunx vitest run src/test/architecture` has a large pre-existing failing set
  (WMS grants, unrelated domains). Reporting tests all pass. Do not treat the
  baseline as a regression from this wave, but do not add to it either.

## Instructions for the next agent

1. **Verify before extending.** Re-run
   `bunx vitest run src/test/architecture/report-statement-snapshot.test.ts
   src/test/architecture/statement-row-footing.test.ts
   src/test/architecture/statement-inactive-accounts.test.ts
   src/test/architecture/report-branch-scope-parity.test.ts
   src/test/architecture/report-format-parity.test.ts` and `tsgo --noEmit -p
   tsconfig.app.json`. Then read the four files this wave touched
   (`src/lib/reports/branchScopability.ts`,
   `supabase/functions/_shared/reports/branchScopability.ts`,
   `supabase/functions/_shared/reportDataEngine.ts#getGLAccountBalances`,
   `src/hooks/useFinancialReport.ts#fetchAccounts`) and confirm the claims above
   against the code, not against this document.
2. **Then resume at Phase F**, not elsewhere. Bring comparatives to a coherent
   state across screen and export before starting Phase G.
3. Keep the invariant this wave established: one registry, one rule, and every
   statement foots to the rows it shows.
