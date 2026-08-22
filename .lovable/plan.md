# BUDGETS domain — authoritative status (wave 1)

Last updated: 2026-08-22 22:20 UTC — handover verification by the incoming engineer.
Investigation findings and domain conclusions remain in `.lovable/plan/budgets-domain-rework-contract-wave-1-2026-08-22.md`. This file is the execution contract: what is genuinely done, what is defective, what is next.

Scope boundary unchanged: Budget only. Chart of Accounts, GL, fiscal periods, analytic accounting and the reporting engine are consumed, not modified.

Architectural invariants (do not regress):
1. A budget is a planning object — it never posts journal entries.
2. Actuals are derived server-side by one RPC. React consumes numbers and never aggregates the ledger.
3. Periods come from `fiscal_periods`; `fiscal_year`/`period_month` are display-only derivations.
4. Variance is favourable-positive, computed in SQL from `accounts.account_type`; income and expense are never netted into one headline figure.
5. Lifecycle `draft → active → closed` is enforced by DB triggers/RPCs; post-activation change is a numbered revision, never an in-place edit.
6. Budgeting stays account-based — no dimensional/analytic budgeting, no encumbrance control, no hard posting blocks.

---

## Handover verification verdict (2026-08-22)

| Phase | Previous claim | Verified verdict |
| --- | --- | --- |
| 0 — Security hotfix | complete, verified | **CONFIRMED.** `check_budget_variance` requires `_business_id`, gates on `finance_can_read_scope`/`_branch`/`_financials`, validates business↔org and branch↔business parentage, and filters the ledger by `ledger_visible_journal_statuses()`, excluding closing/opening/sample. |
| 1 — Domain model | complete, verified | **CONFIRMED** at the schema level (`budget_status` enum, lifecycle guard, `fiscal_period_id` FK, revisions tables, guarded RPCs present). |
| 2 — Actuals RPC | complete | **CONFIRMED as superseded**; `budget_actuals` and `recalculate_budget_actuals` no longer exist and nothing in `src/` references them (only a negative assertion in the arch test). |
| 3 — Lifecycle & editing | complete | **CONFIRMED** in code; tests still owed (Phase 6). |
| 4 — Reporting | "code complete, verification pending" | **NOT COMPLETE — three defects found in `get_budget_variance_report` (below).** Frontend consumers are correct and thin. |
| 5 — Integration & cleanup | not started | **CONFIRMED not started**, and worse than described (below). |
| 6 — Regression protection | not started | Confirmed not started. |

Verification evidence run this session: `pg_get_functiondef` on `get_budget_variance_report`, `check_budget_variance`, `_budget_assert_read`, `ledger_visible_journal_statuses`; `information_schema` on `fiscal_periods`/`businesses`; repo-wide grep for `budget_actuals`; read of `useBudgetVsActual.ts`, `useGLPosting.ts`, `useFiscalPeriodDetail.ts`; vitest on the two budget architecture test files — budget assertions green, the 6 failures are the documented pre-existing Partner Ledger / Journal / Cash Flow / Audit Trail / ReportPageLayout ones.

---

## Phase 4 — Reporting — REOPENED (defects, must close before Phase 5)

**D1 — FACT — reversed entries are silently dropped from actuals.**
`get_budget_variance_report` filters `je.status = 'posted'`, while the platform's ledger-visibility contract is `ledger_visible_journal_statuses() = {posted, reversed}` and `check_budget_variance` (the posting warning) uses that function. Consequence: the budget report and the posting warning disagree, and the budget report disagrees with every other GL-derived report about the same account and period. Fix: use `je.status = ANY (public.ledger_visible_journal_statuses())`.

**D2 — FACT — the report is still calendar-year bound for non-January fiscal years.**
Periods are selected with `EXTRACT(YEAR FROM fp.start_date)::int = b.fiscal_year`. `businesses.fiscal_year_start` exists, so a business whose year starts in e.g. July has six of its twelve monthly `fiscal_periods` outside that calendar year: those periods are dropped, their plan lines get a NULL period and their ledger activity is never counted. This is invariant 3 violated in the very function that claims it. Fix: resolve the budget's period set from the business's fiscal-year window (`fiscal_periods` of `period_type='month'` contained in the `period_type='year'` row for the budget's fiscal year, falling back to a window derived from `businesses.fiscal_year_start`), and expose a fiscal period ordinal alongside the calendar `period_month` so the UI can label months in fiscal order.

**D3 — FACT — plan and ledger are matched on `period_month`, not on the fiscal period.**
`combined` joins `planned` to `ledger` on `(account_id, period_month)`, and `planned` groups by `COALESCE(bi.fiscal_period_id, p.period_id)`. So `budget_items.fiscal_period_id` — the FK Phase 1 introduced precisely to be the period authority — does not actually drive the match, and a line whose stored period disagrees with its `period_month` will bucket inconsistently. Fix: make `fiscal_period_id` the join key on both sides once D2 lands.

**Also required to close Phase 4 (unchanged from the previous engineer's list, none of it done):**
- There are currently **0 rows in `budgets` and `budget_items`** in this database, so nothing about the report has ever been exercised against data. Verification must use a purpose-built fixture, not the live tenant.
- Parity check: report actual for one account/period vs `get_account_movements` over the same window.
- Prove exclusion of closing/opening/sample entries and correct movement of the actual when an entry is reversed (this only becomes meaningful after D1).
- Prove branch-scoped vs company-wide budgets return different, correctly scoped actuals.
- Browser pass over `/reports/budget` and the budget edit page: no console errors, badges match the favourable-positive convention, drill-down opens the right journal lines.

---

## Phase 5 — Integration & cleanup — NOT STARTED (next after Phase 4 closes)

**D4 — FACT — a second, contradictory budget-vs-actual calculation lives in React.**
`src/hooks/useFiscalPeriodDetail.ts` (~line 393) queries `budget_items` directly and (~line 527) computes `actual = Math.abs(accountBreakdown.net)` and `variance = actual − budgeted`. That is: an absolute value instead of a normal-balance signed movement, unfavourable-positive variance (the inverse of invariant 4), calendar month/year selection, no branch scope, and a `variancePercent` of 0 when there is no plan. The period-close screen therefore shows different numbers from the budget report for the same period. Fix: consume `get_budget_variance_report` (add a period-scoped variant taking `_fiscal_period_id`, resolving the business's active budget) and delete the local computation and the `budget_items` query.

**D5 — FACT — codemod residue in the same file.** Several queries carry duplicated `.eq("business_id", businessId)` / `.eq("business_id", currentBusiness.id)` pairs (fixed assets, depreciation, bills). Harmless today but misleading; clean the ones in the blocks this phase touches, do not sweep the file.

**D6** — Posting warning (`useGLPosting`) is already scope-correct and non-blocking; the remaining work is suppressing it for opening/closing-type sources beyond `year_end_closing`, and verifying it agrees with the report after D1.

**D7** — Remove the remaining dead code and the misleading `SCOPE-EXEMPT` comment where RLS now proves the scope.

---

## Phase 6 — Regression protection — NOT STARTED

- Architecture tests: no GL aggregation in any budget consumer (extend the existing assertion to `useFiscalPeriodDetail`); no client write to any actuals surface; no direct `budget_items` read outside the budget feature.
- RLS/isolation tests: business A cannot read business B's budget, lines or revisions; cross-org `check_budget_variance` raises `42501`; `get_budget_variance_report` on a foreign budget raises `42501`.
- Accounting fixtures covering the Phase 4 verification list (non-January fiscal year, reversal, closing/opening/sample exclusion, branch scope), wired into CI.
- Lifecycle tests: illegal transitions rejected; edit-after-activation produces a numbered revision; edit inside a closed period fails.

---

## Execution order

D1 → D2 → D3 (one migration, they touch the same function) → Phase 4 verification fixtures → D4/D5/D6/D7 → Phase 6.

**Do not**: introduce dimensional/analytic budgeting, encumbrance control, forecasting or AI commentary; re-add a stored/materialised actuals table; make the posting warning blocking; move variance or sign logic into React; or repair the six unrelated failing report assertions while in this wave.

**Always**: update this file immediately after each slice so it stays the authoritative status record.
