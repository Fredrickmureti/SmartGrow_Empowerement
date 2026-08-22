# Financial Statements (P&L + Balance Sheet) — Audit Findings & Execution Plan

Evidence labels: **[VF]** verified fact (code/DB read this pass) · **[AP]** accounting
principle · **[RC]** research-based conclusion · **[INF]** inference · **[UV]** unverified.

## 1. Current architecture (VF)

Two statement implementations, one shared arithmetic kernel, one SQL ledger:

```text
journal_entries + journal_entry_lines
   └─ get_account_movements(_org,_from,_to,_business,_branch)      SQL, SECURITY DEFINER
   └─ get_ledger_opening_balances(_org,_business,_as_of,_branch)   SQL, SECURITY DEFINER
        ├─ SCREEN  useFinancialReport.ts → FinancialReports.tsx → manual CSV/XLSX/PDF
        └─ SERVER  _shared/reportDataEngine.ts (buildBalanceSheet / buildIncomeStatement)
                   → render-report + process-scheduled-reports (scheduled PDF/Excel)
```

- Both bind `_shared/reports/accountingKernel.ts` for `isDebitNormal`,
  `calculateBalance`, sub-type classification, section ordering. No raw journal
  summation in the browser.
- Ledger visibility = `ledger_visible_journal_statuses()` = `{posted, reversed}`.
  Drafts excluded; a reversed original and its reversal both appear and net to
  zero. **[VF]** Correct treatment. **[AP]**
- Multi-company gate: with >1 active business and none selected, the hook returns
  `requiresConsolidation` instead of summing ledgers. **[VF]** Correct. **[AP]**
- Live data check this pass: A 95,840 = L (−5,010) + E 100,400 + NI 450. The
  equation holds today. **[VF]**

## 2. Invalidated assumptions

- "Screen and PDF are the same statement" — **false**. They are two builders with
  different retained-earnings math and different P&L structure (§4, §5).
- "Opening balances are entirely SQL-owned" — true for balances, **false** for
  retained earnings: prior years live in SQL, the current year is recomputed in JS
  on both sides, differently.
- "Two reports is too few" — not the defect. Cash Flow, Trial Balance, GL, Partner
  Ledger already exist as separate registry families. Statement of Changes in
  Equity is the only genuinely missing IAS 1 primary statement. **[RC]**
- "Tenant isolation is enforced by RLS" — the ledger tables carry business+branch
  RLS, but every statement path bypasses it (§7).

## 3. Chart of accounts & classification

- Authoritative: `accounts.account_type` (5 types, DB column) then
  `accounts.detail_type` → sub-type; **code-range inference is the fallback**
  (1000-1499 current assets … 7500-7999 tax). **[VF]**
- 18 active accounts have `detail_type IS NULL` (asset 6, liability 6, equity 1,
  income 1, expense 4) and are therefore classified by code number alone. **[VF]**
  Silent misclassification risk: an account outside the assumed numbering lands in
  the wrong statement section with no warning. Severity: medium.
- Retained earnings target resolution: `default_account_settings.retained_earnings`
  first, else lowest-code equity account with `detail_type='retained_earnings'`;
  if neither exists the prior-year result is **silently dropped** and the opening
  trial balance stops balancing. **[VF]** No diagnostic is raised. Severity: high.

## 4. Balance Sheet findings

**B1 — Prior-year earnings are double counted on screen. CRITICAL. [VF]**
`useFinancialReport.ts` (balance_sheet branch) computes
`retainedEarnings` from `get_account_movements('1900-01-01' … dateTo)` — i.e. **all
time** — and adds it to `sectionTotals.equity`. But
`get_ledger_opening_balances` already folds every closed fiscal year's result into
the retained-earnings account, which is inside that equity total. Prior-year profit
is therefore counted twice, and the on-screen "balance check" (`netAmount`) becomes
non-zero by exactly that amount. Latent today only because the single business with
a ledger has no pre-current-FY nominal activity (`prior_year_result = 0`). **[VF]**

**B2 — Screen and PDF disagree. CRITICAL. [VF]** `reportDataEngine.buildBalanceSheet`
derives retained earnings as `closing − nothing` over income/expense = **current
fiscal year only**, which is the correct figure and is labelled "Current Year
Earnings". So the same business, same date, produces two different equity totals
depending on whether you look at the screen or the scheduled PDF.

**B3 — Branch not threaded into the server builder. [VF]** `buildBalanceSheet(...)`
takes no `branchId` and never forwards one, while `buildTrialBalance` does. The
screen treats Balance Sheet as entity-level (`ReportBranchFilter reportKind=
"balance_sheet"` renders an "Entity-level report" hint), which is the defensible
accounting position **[AP]** — a branch is not a legal entity and has no equity —
so the fix is to make that rule explicit and identical on both sides, not to add
branch slicing.

**B4 — Client retained-earnings call drops `branchId`. [VF]** Even inside the
branch-aware hook, that one RPC call omits the parameter. Harmless only while B3's
entity-level rule holds; it is an accident, not a decision.

**B5 — No Statement of Changes in Equity, and no split of retained earnings into
opening RE / current result / movements. [VF]** Equity is presented as a flat
subtype list plus one synthetic line. **[RC]** IAS 1 requires the movement
reconciliation; every comparable ERP (Xero, QuickBooks, Odoo, NetSuite) shows at
minimum "Retained earnings brought forward" and "Current year earnings" separately.

## 5. Profit & Loss findings

**P1 — Structure diverges between screen and PDF. [VF]** Screen: Revenue → COGS →
Gross profit → OpEx → Operating profit → Other income/expense → Profit before tax →
Tax → Net profit. Server PDF: Total income → COGS → Gross profit → Expenses → Net
income, with no operating profit, no other-income separation and no tax line. Same
report name, different statement.

**P2 — Server P&L ignores `branchId` entirely. [VF]** `buildIncomeStatement` has no
branch parameter, so a branch-scoped scheduled P&L silently delivers whole-business
figures. P&L **is** legitimately branch-sliceable **[AP]** (it is performance, not
position), so this is a real defect, not a semantic choice.

**P3 — Total lines are all `_isGrandTotal` on the server. [VF]** Four grand totals
in one statement (TOTAL INCOME, GROSS PROFIT, TOTAL EXPENSES, NET INCOME) violates
the project's own `statementKinds` contract, which the screen already honours
(`calculated_result` vs `grand_total`).

**P4 — Period semantics are correct. [VF]** P&L uses period movement only
(`credit − debit` / `debit − credit` over the selected range); the fiscal-year reset
in `get_ledger_opening_balances` prevents opening balances leaking into P&L.

**P5 — Zero-activity suppression uses the wrong test for nominal accounts. [VF]**
An account is skipped only when period movement **and** opening are both zero; for
income/expense, "opening" is fiscal-year-to-date, so a mid-year P&L prints zero-value
rows for accounts with no activity in the selected period. Cosmetic, low severity.

**P6 — Comparative period is P&L-only and re-runs the same engine. [VF]** Correct.

## 6. Hierarchy findings

- `buildAccountHierarchy` aggregates children into parents on **copies** that never
  reach the rendered rows, so a parent row displays only its own postings while
  being flagged `is_group`. **[VF]**
- Section totals sum leaves only (`!is_group`). No parent/child double counting
  **[VF]** — but a parent that carries its own postings **and** has surviving
  children has those postings **excluded** from the section total. Under-statement,
  not over-statement. Severity: medium, data-dependent (32/44 asset and 39/52
  expense accounts have parents). **[VF]**
- Server builders are flat: no rollup, no hierarchy, sorted by sub-type only.
  Sums are correct; presentation loses the chart of accounts structure. **[VF]**

## 7. Multi-business / branch isolation — the most serious area

- Ledger table RLS **is** business- and branch-aware:
  `journal_entry_lines_select_v3` → `user_can_access_business(auth.uid(), business_id)
  AND (branch_id IS NULL OR user_can_access_branch(...) OR finance.view_consolidated)`;
  `accounts_select_per_business` likewise. **[VF, live pg_policies]**
- **S1 — every statement path bypasses that RLS. CRITICAL. [VF]** The three
  reporting RPCs are `SECURITY DEFINER`, and their only authorization gate is
  `finance_can_read_org(_org_id)` = `service_role OR is_org_member(auth.uid(), org)`.
  There is no business or branch dimension in the gate; the RPC merely verifies the
  supplied `_business_id`/`_branch_id` *belong to* the org. An authenticated member
  of the tenant who has **no** `user_business_access` row for Business B can call
  `get_account_movements`/`get_ledger_opening_balances` with B's id and receive B's
  ledger aggregates. This directly contradicts the stated non-negotiable rule.
- **S2 — `render-report` repeats the same mistake. CRITICAL. [VF]** It runs a
  service-role client and gates on `user_roles` **organization** membership only,
  then passes body-supplied `businessId`/`branchId` straight into the builders. Any
  org member can request any sister business's P&L/Balance Sheet PDF.
- **S3 — runtime proof outstanding. [UV]** Reproduce with two users before and
  after the fix; a single tenant with one business exists today so this cannot be
  observed from current data.
- Direct PostgREST reads in the hook (`accounts`) *are* RLS-protected, so the screen
  degrades to "no accounts" rather than leaking metadata — but the RPC balances are
  returned regardless. **[VF]**

## 8. FX

`journal_entry_lines.debit/credit` are base currency; document currency lives in
`original_debit/original_credit`. Statements present base currency only, with no
reporting-currency translation and no CTA/OCI. **[VF]** This is a defensible scope
boundary **[AP/RC]** (IAS 21 translation is a consolidation feature) but it is
undocumented on the statement masthead, so a reader cannot tell. No client-side FX
arithmetic exists — correct.

## 9. Export / PDF parity

- Manual export from the screen serialises the **same row model** the screen renders
  (`toExportRows`) → parity holds. **[VF]**
- Scheduled/`render-report` output is built by a **different** engine → parity fails
  on both statements (B2, P1, P2). **[VF]** No parity test exists for
  screen-vs-`reportDataEngine` statement output. **[VF]**

## 10. Verdict

| Area | Verdict |
|---|---|
| P&L accounting correctness (screen) | Correct |
| P&L (server/PDF) | Correct but incomplete (structure, branch) |
| Balance Sheet (screen) | **Incorrect** (prior-year RE double count) |
| Balance Sheet (server/PDF) | Correct but incomplete |
| CoA classification | Correct but incomplete (18 null detail_types, RE fallback silent) |
| Account hierarchy | Incorrect (parent own-postings dropped from totals) |
| Period semantics | Correct |
| Retained earnings | Incorrect (split authority, two answers) |
| Net income treatment | Correct |
| GL / Trial Balance reconciliation | Correct (verified against live ledger) |
| FX integration | Correct but undocumented |
| Multi-business isolation | **Incorrect** (org-level gate only) |
| Branch semantics | Correct but incomplete (server ignores branch) |
| Drill-down | Correct (single resolver, `get_general_ledger`) |
| Export/PDF parity | Incorrect (scheduled path) |
| Presentation quality | Correct but incomplete (no SoCiE, no equity movement) |

## 11. Critical invariants to hold after every phase

1. Assets = Liabilities + Equity, where Equity includes prior-year RE **exactly
   once** and current-year result **exactly once**.
2. Screen figure == scheduled-PDF figure for the same org/business/branch/date.
3. P&L net income == the current-year-earnings line on the Balance Sheet for the
   same fiscal year to the same date.
4. No statement number may be produced for a business the caller cannot access.
5. Every peso of a section total comes from exactly one account row.
6. No new reporting engine; no client-side ledger aggregation; no FX in the browser.

## 12. Dependency-ordered execution phases

**Phase A — Business-level authorization (blocking, security).**
Add `finance_can_read_business(_org, _business)` (org member **and**
`user_can_access_business`, service_role exempt) and call it in
`get_account_movements`, `get_ledger_opening_balances`, `get_general_ledger`,
`get_journal_report`. Add the same check to `render-report` after resolving the
caller. Keep `finance_can_read_org` for the org-only cases.

**Phase B — One retained-earnings authority.**
Extend `get_ledger_opening_balances` (or add `finance_current_year_earnings`) so SQL
returns *both* brought-forward RE and current-period result. Delete the
`1900-01-01` client call and the server's ad-hoc `totalIncome − totalExpenses`.
Present equity as: Share capital → Retained earnings b/f → Current year earnings →
Total equity.

**Phase C — Server/screen statement convergence.**
Give `buildIncomeStatement`/`buildBalanceSheet` the screen's multi-step structure and
the `statementKinds` vocabulary; thread `branchId` into `buildIncomeStatement`;
document Balance Sheet as entity-level in one shared constant used by both
`ReportBranchFilter` and the server builder.

**Phase D — Hierarchy correctness.**
Make parent rows show rolled-up figures and include parents' own postings in section
totals exactly once (roll up onto the rendered rows, total from roots).

**Phase E — Classification hygiene.**
Backfill/require `detail_type` on postable accounts; surface a report-level warning
when any in-scope account was classified by code range or when no retained-earnings
account resolves.

**Phase F — Presentation.**
Statement of Changes in Equity; masthead states basis, currency and scope.

Each phase ships with its tests and is proven before the next starts.

## 13. Tests required

- SQL (`supabase/tests/financial_statements_test.sql`): prior-year profit appears
  once; no-history business; income and expense in current year; reversal; backdated
  posting; year-end rollover; missing retained-earnings account raises; branch-scoped
  P&L excludes other branches; business-scoped call from a non-member is denied.
- Vitest: screen-vs-`reportDataEngine` parity snapshot for both statements; hierarchy
  totals with a parent carrying its own postings; zero-activity behaviour;
  comparative period; classification fallback warning.
- Runtime: two-user cross-business probe against the RPCs and `render-report`,
  before and after Phase A.

## 14. Scope boundaries

- No second reporting engine; no client-side ledger aggregation; no FX translation
  work; no changes to the posting engine or ADR-0123's posting monopoly.
- Trial Balance, GL, Journal Report, Partner Ledger, Cash Flow and Consolidation are
  out of scope except where a shared function must change.

## 15. Execution status

Investigation complete. No code changed. Phase A not started.
