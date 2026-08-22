# BUDGETS domain — rework contract (wave 1)

Legend: **FACT** = verified in this repo/database. **STD** = established accounting/ERP practice. **INFER** = reasoned conclusion.

Scope boundary: Budget only. Chart of Accounts, GL, fiscal periods, analytic accounting and the reporting engine were inspected solely to establish Budget's contract with them.

---

## 1. Domain conclusions

- **STD** A budget is a *planning object*, not an accounting transaction. Creating, activating or closing a budget must never create journal entries. Odoo, NetSuite, Dynamics 365 BC and QuickBooks all model it as planned amount × account × period (× optional dimension), with actuals read live from the ledger.
- **STD** The "actual" side is **derived**, never authored. It is the sum of posted GL movement on the budgeted account, inside the budgeted *fiscal period*, inside the budgeted business/branch scope, using the account's normal-balance sign. A stored actual is only acceptable as an explicitly invalidated materialization — never as a user-triggered snapshot.
- **STD** Budgets are keyed to **fiscal periods**, not calendar months. A budget whose periodicity is "month 1..12 of a calendar year" is wrong for any business whose fiscal year does not start in January.
- **STD** Variance meaning depends on account nature: for expense accounts actual > budget is *unfavourable*; for income accounts actual < budget is *unfavourable*. A single signed `budgeted - actual` across mixed account types is not a reportable figure.
- **STD** Activation freezes the plan; post-activation change requires a **revision** with history, not in-place mutation. Closing a budget makes it read-only.
- **INFER (recommended for THIS system)** Keep budgeting **account-based, per business, optionally per branch, per fiscal period**, with revisions and live-computed actuals.
  - Dimensional/analytic budgeting: **do not build now**. **FACT** `journal_entry_lines.analytic_account_id` exists but 0 of 37 lines use it; analytic accounting has no adoption to budget against.
  - Commitment/encumbrance control (budget-checking requisitions/POs): **do not build now**. **FACT** no purchasing table or code path references budgets. Adding it would be speculative.
  - Hard budget blocking on posting: **do not build**. Warning-only is correct for this system; it must simply be *scoped and authorized* correctly.

### Challenge to the brief
The brief asks whether budgets should participate in reversals, credit notes, opening balances and year-end closing as distinct events. **INFER** they should not be modelled as separate budget events at all: all of them land in the GL, so a correct live actuals query handles every one of them for free. The only ones needing explicit handling are **closing/opening entries**, which must be *excluded* from P&L actuals, and **period close**, which is a read/authorization concern, not a budget event.

---

## 2. What we actually have (verified)

Tables: `budgets(organization_id, business_id NOT NULL, branch_id NULL, name, fiscal_year int, status text, description, created_by)`, `budget_items(budget_id, account_id, period_month 1..12, budgeted_amount, notes)`, `budget_actuals(organization_id, business_id, budget_id, account_id, period_month, fiscal_year, actual_amount, calculated_at)`.

Code surface: `src/hooks/useBudgets.ts`, `src/hooks/useBudgetVsActual.ts`, `src/pages/Budgets.tsx`, `src/features/finance/budgets/{BudgetCreatePage,BudgetEditPage,CopyBudgetDetailSheet}.tsx`, `src/components/budgets/BudgetVsActualDialog.tsx`, `src/pages/reports/BudgetReport.tsx`, plus two outside consumers: `src/hooks/useGLPosting.ts` (RPC `check_budget_variance`) and `src/hooks/useFiscalPeriodDetail.ts` (direct `budget_items` read).

**FACT** There is no database function, trigger or server function that computes or maintains budget actuals. Actuals exist only as rows written by the **browser** in `useBudgetVsActual.calculateActuals`, on a manual "Calculate actuals" click.

**FACT** Current data: 1 budget (draft, FY2026), 0 budget_items, 0 budget_actuals, 37 journal entry lines, 13 fiscal periods (2026, calendar-aligned, all `open`). The module is effectively unused — a corrective rework carries no data-migration burden.

---

## 3. Confirmed defects

### 3.1 Security / isolation (critical)
1. **FACT `check_budget_variance` leaks across tenants.** `SECURITY DEFINER`, `EXECUTE` granted to `authenticated`, takes `_org_id` as an argument and performs **no membership check**. Any authenticated user of any tenant can pass another organization's id and receive that org's budget names, budgeted amounts and posted GL actuals per account. Compare `get_account_movements`, which gates on `finance_can_read_scope` / `finance_can_read_branch` / `finance_can_read_financials` and validates business/branch parentage.
2. **FACT `budget_items` SELECT policy is organization-wide.** `Users can view budget items` only requires the parent budget's `organization_id ∈ get_user_organizations(auth.uid())` — no business check, no branch check, no `financials` module permission. Any org member can read the budget lines of a business they have no access to. (Write policies are correct: business + `finance.manage_budgets`.)
3. **FACT `budget_actuals` policies are organization-wide with no finance permission.** SELECT/INSERT/UPDATE only check `organization_id ∈ user_roles`. Any org member can read another business's actuals and **insert or update arbitrary actual amounts** for any business in the org — the displayed "actual" column is user-forgeable.
4. **FACT `useFiscalPeriodDetail`** reads `budget_items` filtered by org + `budgets.status='active'` + month, with **no business filter** — cross-business budget figures reach a period screen, enabled by defect 2.
5. **FACT** Branch isolation for budget reads relies on `useBudgets` client-side `.or(branch_id.eq…,branch_id.is.null)`; the RLS SELECT policy on `budgets` does gate branch access, so this is presentation only — acceptable. The actuals path has no branch authorization at all beyond the budget's own `branch_id` echoed back by the client.

### 3.2 Accounting correctness
6. **FACT Actuals are computed in the browser** over raw `journal_entry_lines`, filtered only by `account_id` (+ optional `journal_entries.branch_id`). No `organization_id` or `business_id` predicate; isolation rests entirely on accounts being business-scoped. This is a business-critical calculation in React — it must move server-side.
7. **FACT Silent truncation at 1,000 rows.** The line query is unpaginated, so Supabase's default row cap applies. Beyond ~1,000 posted lines on budgeted accounts the actuals are simply **wrong**, with no error. This is a correctness defect, not just a scale one.
8. **FACT Wrong ledger visibility rule.** The client hardcodes `status !== 'posted'`; the authoritative engine uses `ledger_visible_journal_statuses()`. Two competing definitions of "in the ledger".
9. **FACT Closing/opening entries are not excluded.** `journal_entries.is_closing`, `is_closing_entry`, `is_opening_entry` are ignored. Once year-end closing runs, P&L actuals for the year net toward zero. (0 closing entries exist today, so the bug is latent.)
10. **FACT Sample data is not excluded** (`journal_entry_lines.is_sample_data`, `journal_entries.is_sample_data`).
11. **FACT Calendar-year assumption.** Fiscal year is matched with JavaScript `new Date(entry_date).getFullYear()` and month with `getMonth()+1`, ignoring `fiscal_periods` entirely — the authoritative period engine (`fiscal_periods`, `close_fiscal_period`, `reopen_fiscal_period`, `enforce_fiscal_period_lock`). Non-January fiscal years are mis-bucketed; timezone parsing of `entry_date` can also shift a month boundary.
12. **FACT Variance is sign-blind.** `variance = budgeted - actual` and `status` thresholds (±10%, hardcoded) are applied identically to income and expense accounts, and `totalBudgeted`/`totalActual` sum income and expense lines into one figure. Under-earned revenue currently reads as "under budget / favourable".
13. **FACT `variancePercent` is 0 whenever `budgeted <= 0`**, hiding actual spend on zero-budget lines (a case standard ERP reports surface as infinite/unbudgeted).
14. **FACT No currency identity.** Neither `budgets` nor `budget_items` carries a currency; actuals sum base-currency `debit`/`credit` while `original_currency`/`exchange_rate` exist on the line. Budgets are implicitly base currency and never labelled as such.
15. **FACT Stale by construction.** Nothing invalidates `budget_actuals` when a journal is posted, voided, reversed, or a period is closed. `calculated_at` is the only signal and no UI treats it as staleness.

### 3.3 Lifecycle, integrity, quality
16. **FACT Update destroys and recreates all lines.** `useBudgets.updateBudget` deletes every `budget_items` row then re-inserts — losing row ids and notes, non-idempotent, racy under concurrent edit, and it orphans `budget_actuals` rows keyed to the old lines.
17. **FACT Lifecycle is a bare `text` column.** `status` is a CHECK-constrained text field mutated by direct client `UPDATE`. No state machine, no transition guard, no approval, and RLS permits header/line writes on `active` and `closed` budgets — read-only behaviour is enforced only by the UI (`isReadOnly` in `BudgetEditPage`).
18. **FACT No revision/version history and no audit trail.** No `budget_versions` table; nothing writes to `audit_logs`. Post-activation changes are untraceable.
19. **FACT No fiscal-period lock respected.** Budget lines for a closed period can be edited freely.
20. **FACT `budget_items.account_id` and `budget_actuals.account_id` are `ON DELETE CASCADE` to `accounts`.** Deleting a chart-of-accounts row silently deletes budget lines. `DeleteAllAccountsDialog` exists, making this reachable.
21. **FACT No constraint ties a budget line's account to the budget's business.** A line may reference another business's account; only UI filtering prevents it.
22. **FACT Missing constraints/indexes.** No uniqueness on `(business_id, fiscal_year, name)`, nothing preventing two `active` budgets for the same scope/year (which `check_budget_variance` resolves with an arbitrary `LIMIT 1`). No index on `budgets(branch_id)`, `budgets(business_id, fiscal_year, status)`, or `budget_actuals(business_id)`.
23. **FACT Duplicated actuals logic.** The same sign convention is implemented twice — in `useBudgetVsActual` (TS) and in `check_budget_variance` (SQL) — with different scoping rules. Two competing sources of truth.
24. **FACT Duplicated chart math.** `BudgetEditPage` re-implements `getChartData` as a fallback alongside the hook's version.
25. **FACT Misleading comment** in `useBudgetVsActual` claims `budget_actuals` is "business-scoped via budget_id"; the RLS proves otherwise (defect 3).

### 3.4 Genuinely missing
- Fiscal-period-anchored budget periods; revisions; approval/lock; auditability of every figure; drill-down from a variance cell to the underlying journal lines (`get_gl_transactions` exists and is unused by Budget); branch/consolidated budget comparison; unbudgeted-actual visibility; staleness-free actuals.

### 3.5 Genuinely unnecessary / should not be built
- `budget_actuals` as a client-written cache → **delete the write path**; compute live.
- Dimensional/analytic budgeting, encumbrance control, budget-driven forecasting, AI insights, per-report duplicates of Budget vs Actual → **not now**.
- The `BudgetVsActualDialog` + `reports/budget` + `BudgetEditPage` analysis tab are three renderings of one report → collapse to one report surface plus an embedded view.

---

## 4. Architectural decisions

1. **Actuals are computed server-side by one authoritative RPC**, modelled exactly on `get_account_movements`: `SECURITY DEFINER`, `finance_can_read_scope` + `finance_can_read_branch` + `finance_can_read_financials`, business/branch parentage validation, `ledger_visible_journal_statuses()`, closing/opening and sample data excluded, aggregation in SQL. React consumes numbers; it never derives them.
2. **Periods come from `fiscal_periods`**, resolved server-side. `fiscal_year`/`period_month` remain only as derived display.
3. **`budget_actuals` stops being writable by clients.** Either dropped or retained as an RPC-only materialization; the client write path is removed either way.
4. **Sign convention lives with the account nature** (`accounts.account_type`) in SQL, producing `budget`, `actual`, `variance`, `variance_pct`, `favourable boolean` — one definition, one place.
5. **Lifecycle becomes an enum with DB-enforced transitions** (`draft → active → closed`), plus revision rows for post-activation change; guards live in triggers/RPCs, not in React.
6. **Budget stays account-based**; no new dimension tables until analytic adoption exists.

---

## 5. Phased execution (dependency-ordered)

### Phase 0 — Security hotfix (do first, independently shippable)
- Rewrite `check_budget_variance` to derive scope from the caller: require `_business_id`, enforce `finance_can_read_scope`/`_branch`/`_financials`, validate business↔org parentage, resolve the budget by business (+branch) and fiscal period, and use `ledger_visible_journal_statuses()`. Until it is correct, the `useGLPosting` call passes the business/branch from the posting context.
- Replace the org-wide `budget_items` SELECT policy with a business+branch+`financials read` policy mirroring `budgets_select_v2`.
- Replace all four `budget_actuals` policies: SELECT gated by the parent budget's business/branch access; **revoke client INSERT/UPDATE/DELETE** entirely.
- Fix `useFiscalPeriodDetail`'s `budget_items` query to filter by the current business.
- Validation: policy-level tests proving a member of business A cannot read business B's budget lines or actuals; a cross-org `check_budget_variance` call raises `42501`.

### Phase 1 — Domain model correction (migration)
- `status` → enum + transition trigger; block line/header writes on `active`/`closed` (except through the revision path) and on closed fiscal periods.
- Add `budget_periods` linkage to `fiscal_periods` on budget lines (keep `period_month` derived), `currency_code` on `budgets` defaulting to the business base currency, `business_id` denormalized onto `budget_items` with a check that it matches both the parent budget and the referenced account.
- FKs: `account_id` → `ON DELETE RESTRICT`. Uniqueness: `(business_id, coalesce(branch_id), fiscal_year, name)`; at most one `active` budget per `(business_id, branch_id, fiscal_year)`. Indexes: `budgets(business_id, fiscal_year, status)`, `budgets(branch_id)`, `budget_items(budget_id, fiscal_period_id)`.
- `budget_revisions` + `budget_revision_lines`; audit entries on create/activate/revise/close/delete.
- Validation: migration tests for each constraint and each blocked transition.

### Phase 2 — Authoritative Budget vs Actual RPC
- `get_budget_vs_actual(_budget_id, _branch_id?)` returning per line and per period: budgeted, actual, variance, variance %, favourable flag, plus unbudgeted-actual rows for accounts with GL movement and no budget line.
- Delete `calculateActuals` and every GL query in `useBudgetVsActual`; the hook becomes a thin `useQuery` over the RPC. Remove the duplicated chart math in `BudgetEditPage`.
- Retire the client-written `budget_actuals` path (drop the table or keep it RPC-only).
- Validation: SQL fixtures covering income vs expense sign, non-January fiscal year, closing entry exclusion, voided/reversed entries, >1,000 lines, branch-scoped vs company-wide budgets, and a parity check against `get_account_movements`.

### Phase 3 — Lifecycle & editing correctness
- Replace delete-all/re-insert with per-line upsert/delete keyed on `(budget_id, account_id, fiscal_period_id)`; revision flow for activated budgets with history UI; closed-period and closed-budget errors surfaced from the DB, not hidden by the UI.
- Validation: concurrent-edit test; edit-after-activation produces a revision; edit in a closed period fails.

### Phase 4 — Reporting
- One Budget vs Actual report surface driven by the Phase 2 RPC: period × account matrix, favourable/unfavourable colouring, branch and consolidated comparison, drill-down through `get_gl_transactions`, export/print through the existing reporting engine. Collapse `BudgetVsActualDialog` and the edit-page analysis tab into embedded views of it.
- Not built: dimensional analysis, forecast, AI commentary.

### Phase 5 — Integration & cleanup
- Posting warning uses the Phase 0 RPC with full business/branch/period scope, stays non-blocking, and is suppressed for closing/opening entries.
- Period-close screen consumes the RPC instead of raw `budget_items`.
- Remove dead code and the misleading `SCOPE-EXEMPT` comment.

### Phase 6 — Regression protection
- Architecture tests asserting no GL aggregation in `src/hooks/**` budget code and no client writes to actuals; RLS isolation tests; RPC accounting fixtures wired into CI.

---

## 6. Execution status

| Phase | Status |
| --- | --- |
| 0 — Security hotfix | not started |
| 1 — Domain model | not started |
| 2 — Actuals RPC | not started |
| 3 — Lifecycle | not started |
| 4 — Reporting | not started |
| 5 — Integration | not started |
| 6 — Regression | not started |
