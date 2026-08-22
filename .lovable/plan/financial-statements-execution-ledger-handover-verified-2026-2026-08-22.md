# Financial Statements — Execution Ledger (handover verified 2026-08-22)

Companion findings doc: `.lovable/plan/financial-statements-p-l-balance-sheet-audit-findings-execut-2026-08-22.md`.
This file tracks what is **proven done** and what is **pending**.

## Handover verification of the predecessor's claims (this wave)

All "DONE" claims were re-checked directly, not trusted.

- **VERIFIED FACT — Phase A / A+ (authorization).** `pg_get_functiondef` over
  `get_account_movements`, `get_ledger_opening_balances`, `get_equity_result`,
  `get_general_ledger`, `get_journal_report` shows all five contain
  `finance_can_read_scope`, `finance_can_read_branch` and
  `finance_can_read_financials`. Both helper functions exist. Claim is true.
  *Residual gap unchanged:* gates are proven by definition inspection only; no
  live authenticated call (project is `external_unmanaged`). SQL tests still owed.
- **VERIFIED FACT — Phase B (retained earnings / fiscal-year anchoring).**
  `src/hooks/useFinancialReport.ts` resolves `get_equity_result` first and uses
  `fiscal_year_start` as `effectiveDateFrom` for movements and openings (L309–351);
  equity adds `current_year_earnings` always and `prior_years_result` only when no
  retained-earnings account exists (L534–557). `reportDataEngine.buildBalanceSheet`
  mirrors it. Claim is true.
- **VERIFIED FACT — drill-down fix.** `FinancialReports.tsx` L218 compares
  `activeTab === "balance_sheet"`. Claim is true.
- **VERIFIED FACT — tests.** `bunx vitest run src/test/architecture/report-statement-snapshot.test.ts`
  → 4 passed.
- **CORRECTED CLAIM — Phase C remainder.** The plan listed "thread `branchId` into
  `buildIncomeStatement`" as pending; it is already threaded (`reportDataEngine.ts`
  L580–586) and passed by both `render-report` and `process-scheduled-reports`.
  Note `buildBalanceSheet` is deliberately called **without** branch — consistent
  with the screen (`branchId: null`) and with the entity-level principle. What is
  genuinely still missing is that this rule lives in two places rather than one
  shared constant.

## NEW VERIFIED DEFECT — screen totals do not equal the sum of screen rows (Phase D)

ACCOUNTING PRINCIPLE: a statement's section total must be the sum of the rows the
reader can see; a posting account must be presented exactly once.

Evidence:
- `useFinancialReport.ts` L493–502 computes `sectionTotals` by summing **every**
  account's own `display_amount`, including accounts flagged `is_group`.
- `FinancialReports.tsx` L90–97 `classifyAccounts` does `.filter(a => !a.is_group)`,
  so those same group accounts are **never rendered**.
- `FinancialReports.tsx` L476–478 takes Total income / Total expenses / Total assets
  from `sectionTotals`.

Consequence: for any parent account that has both its own postings and children
(common for control accounts and legacy charts), the amount is counted in the
section total but has no visible row. The statement silently fails to foot, and
`rollup_amount` — computed at L470–478 — is dead code, consumed nowhere.

Divergence: the server builder (`buildIncomeStatement` L587–611) renders a **flat**
list of all accounts including parents, so the PDF shows a row the screen omits.
UI and PDF present different row sets for the same figures.

## Pending, in dependency order

1. **Phase D — hierarchy correctness and footing (next).**
   Decide one presentation contract and apply it to both paths: render posting rows
   for every account with its own amount (parents included, indented by depth), show
   group rows as roll-up subtotals that are *not* added into section totals, and
   derive each section total from the rendered rows. Assert `sum(rendered rows) ==
   sectionTotal` in tests. Remove `rollup_amount` or give it a real consumer.
2. **Phase C remainder.** One shared constant expressing "balance sheet is
   entity-level, P&L is branch-dimensioned", consumed by `ReportBranchFilter`,
   `FinancialReports.tsx`, `render-report` and `process-scheduled-reports`.
   Structure parity check between screen sections and the multi-step server P&L.
3. **Phase E — classification hygiene.** Report-level warning when an in-scope
   account was classified by code range rather than `detail_type`, and when no
   retained-earnings account resolves.
4. **Deactivated accounts carrying balances.** Both paths filter `is_active = true`
   (`useFinancialReport.ts` L161, `reportDataEngine.ts` L308), so a deactivated
   account with a live balance silently leaves the balance sheet and can break the
   equation. Include non-zero inactive accounts, or block deactivation while a
   balance exists.
5. **Comparative periods on the balance sheet.**
6. **Phase F — Statement of Changes in Equity; masthead states basis, currency, scope.**
7. **SQL tests** (`supabase/tests/`) for the RPC gates: sibling-branch request denied,
   non-member business request denied, head-office all-branches allowed. Closes the
   only remaining unproven security assertion.
8. **Client-path unit test** for `useFinancialReport` fiscal-year anchoring (the
   server path is covered, the client path is not).

## Scope boundaries (unchanged)

No second reporting engine, no client-side ledger aggregation, no FX translation
work, no posting-engine changes. Trial Balance / GL / Journal Report touched only
through the shared authorization functions.

## Execution status

- Predecessor's DONE list: **verified true** (one claim corrected as already done).
- **Active next phase:** item 1, Phase D — hierarchy correctness and footing.
