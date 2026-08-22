# BUDGETS domain — authoritative status (wave 1)

Last updated: 2026-08-22 21:55 UTC.
Source of truth for this domain's status. Investigation findings, domain conclusions and defect catalogue live in the archived contract: `.lovable/plan/budgets-domain-rework-contract-wave-1-2026-08-22.md`. This file tracks **what is done, what is pending, and what comes next**.

Scope boundary unchanged: Budget only. Chart of Accounts, GL, fiscal periods, analytic accounting and the reporting engine are consumed, not modified (except where a budget FK/cleanup defect forced a fix).

Architectural invariants (do not regress):
1. A budget is a planning object — it never posts journal entries.
2. Actuals are **derived server-side** by one RPC. React consumes numbers and never aggregates the ledger.
3. Periods come from `fiscal_periods`; `fiscal_year`/`period_month` are display-only derivations.
4. Variance is **favourable-positive**, computed in SQL from `accounts.account_type`; income and expense are never netted into one headline figure.
5. Lifecycle `draft → active → closed` is enforced by DB triggers/RPCs; post-activation change is a numbered revision, never an in-place edit.
6. Budgeting stays account-based — no dimensional/analytic budgeting, no encumbrance control, no hard posting blocks.

---

## Phase status

| Phase | Status |
| --- | --- |
| 0 — Security hotfix | **complete, verified** |
| 1 — Domain model correction | **complete, verified** |
| 2 — Authoritative actuals RPC | **complete, verified** (superseded by Phase 4's live report) |
| 3 — Lifecycle & editing correctness | **complete** — DB + hooks done; concurrency/revision tests pending in Phase 6 |
| 4 — Reporting | **ACTIVE — code complete, verification pending** |
| 5 — Integration & cleanup | not started ← **next milestone** |
| 6 — Regression protection | not started |

---

## Phase 0 — Security hotfix — COMPLETE

Delivered (migration + code):
- `check_budget_variance` rewritten: `_business_id` mandatory, `finance_can_read_scope` / `finance_can_read_branch` / `finance_can_read_financials` enforced, business↔org parentage validated, budget resolved by business (+branch) and fiscal period, ledger visibility via `ledger_visible_journal_statuses()`. The cross-tenant read via a caller-supplied `_org_id` is closed.
- `budget_items` SELECT policy replaced: business + branch + financials-read, mirroring `budgets_select_v2` (was organization-wide).
- `budget_actuals` policies replaced and **all client INSERT/UPDATE/DELETE revoked** — the actual column is no longer user-forgeable. (Table itself later dropped in Phase 4.)
- `src/hooks/useGLPosting.ts` passes business/branch from the posting context to the RPC.
- `src/hooks/useFiscalPeriodDetail.ts` `budget_items` query scoped to the current business and the period's fiscal year (was org-wide, cross-business).

Verified: typecheck clean; RPC rejects a foreign business; policies inspected post-migration.
Pending for this phase: formal RLS isolation tests → deferred to Phase 6 (deliberate, tracked).

## Phase 1 — Domain model correction — COMPLETE

- `budget_status` enum (`draft|active|closed`) + `_budgets_lifecycle_guard` transition trigger; header/line writes blocked on `active`/`closed` except through the revision RPC, and blocked in closed fiscal periods.
- `budget_items.fiscal_period_id` bound to `fiscal_periods`; `_budget_items_normalize()` resolves the monthly period server-side and asserts the account belongs to the budget's business.
- `budgets.currency_code` defaulting to the business base currency; `business_id` denormalized onto budget tables with matching checks.
- `account_id` FK moved off cascade-delete semantics; uniqueness on `(business_id, branch_id, fiscal_year, name)` and at most one `active` budget per `(business_id, branch_id, fiscal_year)`; supporting indexes added.
- `budget_revisions` + `budget_revision_lines`; `_budgets_audit` writes create/activate/revise/close/delete to `audit_logs`.
- RPCs `set_budget_status` and `apply_budget_revision` (SECURITY DEFINER, permission-gated) are the only lifecycle/edit-after-activation paths.

## Phase 2 — Authoritative actuals — COMPLETE (superseded by Phase 4)

- Server-side computation established, replacing the browser calculation (unpaginated 1,000-row truncation, wrong visibility rule, calendar-year assumption, sample/closing data included — all fixed in SQL).
- Internal trigger functions had `EXECUTE` revoked from `public`/`authenticated`.
- Phase 4 replaced the materialization step with live computation; the RPC contract below is now the single definition of a budget actual.

## Phase 3 — Lifecycle & editing correctness — COMPLETE

- `useBudgets.updateBudget` is a per-line diff (insert/update/delete keyed on account + period) — the delete-all/re-insert path is gone, so ids, notes and referential integrity survive an edit.
- `activateBudget`, `closeBudget`, `applyRevision` call the guarded RPCs; DB errors surface to the user rather than being masked by UI state.
- Cache invalidation targets the finance scope key and `budget-vs-actual`.
- Remaining: concurrent-edit and revision-flow tests → Phase 6.

## Phase 4 — Reporting — ACTIVE (code complete, verification pending)

Database:
- `get_budget_variance_report(_budget_id)` rebuilt as the one authoritative report. Live from the ledger: posted/ledger-visible only, closing + opening + sample activity excluded, the business's own monthly fiscal periods, budget business/branch scope, account normal-balance direction applied, favourable-positive variance by account nature, period dates/status returned, and **unbudgeted** P&L activity surfaced as its own rows. Authenticated + finance-permission gated.
- `budget_actuals` table and `recalculate_budget_actuals` **dropped** — one definition of "actual", zero staleness surface.
- `delete_all_chart_of_accounts` fixed: it previously tried to null `budget_items.account_id` (NOT NULL) and always failed; it now removes budget lines and revision lines.

Frontend:
- `src/hooks/useBudgetVsActual.ts` — thin RPC consumer. No GL query, no sign logic. Returns typed rows plus income / expense / other / net totals, per-account and per-month groupings, and unbudgeted rows.
- `src/hooks/useBudgetRevisions.ts` — revision trail with per-line before/after amounts.
- `src/pages/reports/BudgetReport.tsx` — rebuilt on `@/design-system/reports`: revenue and cost sections plus net result, favourable/unfavourable badges, unbudgeted alert, drill-down using fiscal-period bounds, export/print through the reporting engine.
- `src/features/finance/budgets/BudgetEditPage.tsx` — analysis section now reads the live report (revenue / cost / net cards + unbudgeted count), the "Calculate actuals" button and stored-actuals empty state are gone, per-line rows show the SQL-computed actual and favourable-positive variance, and a **Revision history** section renders the numbered trail.
- `src/components/budgets/BudgetVsActualDialog.tsx` **deleted** — it was an unreferenced third rendering of the same report on the retired API. One report surface remains, embedded on the edit page.
- `src/test/architecture/financial-reports-scope-labeling.test.ts` budget assertion rewritten: the hook must call `get_budget_variance_report` and must contain no `journal_entry_lines`/`budget_actuals` access. Passing.

Verified so far: full `tsgo --noEmit` clean; budget architecture assertion green. (Six failures in that test file are pre-existing and belong to Partner Ledger, Journal, Cash Flow, Audit Trail and ReportPageLayout — out of this domain's scope, do not "fix" them here.)

Pending to close Phase 4:
1. Run the report against seeded data for a **non-January fiscal year** and confirm month buckets follow `fiscal_periods`, not the calendar.
2. Parity check: report actuals for one account/period vs `get_account_movements` for the same window.
3. Confirm a closing entry and a sample entry are both excluded, and that a voided/reversed entry moves the actual correctly.
4. Confirm branch-scoped vs company-wide budgets return different, correctly scoped actuals.
5. Browser pass over `/reports/budget` and the edit page: no console errors, badges match the sign convention, drill-down opens the right journal lines.

## Phase 5 — Integration & cleanup — NOT STARTED (next milestone)

- Posting warning (`useGLPosting`) uses the hardened RPC with full business/branch/period scope, stays **non-blocking**, and is suppressed for closing/opening entries.
- Period-close screen (`useFiscalPeriodDetail`) consumes the authoritative RPC instead of reading `budget_items` directly.
- Remove remaining dead code and the misleading `SCOPE-EXEMPT` comment where RLS now proves the scope.

## Phase 6 — Regression protection — NOT STARTED

- Architecture tests: no GL aggregation anywhere in budget hooks; no client write to any actuals surface; no direct `budget_items` read outside the budget feature.
- RLS isolation tests: business A cannot read business B's budget, lines or revisions; cross-org `check_budget_variance` raises `42501`.
- Accounting fixtures for the Phase 4 verification list above, wired into CI.
- Lifecycle tests: illegal transitions rejected; edit-after-activation produces a revision; edit in a closed period fails.

---

## Handover — instructions for the next agent

**Step 1 — verify before you build.** Do not start Phase 5 until Phase 4 is proven. Work the "Pending to close Phase 4" list above:
- Read `get_budget_variance_report` in the database and confirm each invariant it claims: ledger-visible statuses only, `is_closing`/`is_closing_entry`/`is_opening_entry` and `is_sample_data` excluded, periods joined from `fiscal_periods` for the budget's business, business + branch scope, permission gate present, and favourable-positive variance derived from `accounts.account_type`.
- Confirm nothing anywhere still references `budget_actuals` or writes actuals from the client.
- Run `npx tsgo --noEmit` and the architecture test file; the only failures allowed are the six pre-existing non-budget ones listed above.
- If any check fails, fix it inside Phase 4 and update this file — do not carry a defect forward.

**Step 2 — then resume chronologically at Phase 5**, in the order listed, finishing it to a production-ready state (posting warning, period-close consumer, dead-code removal) before opening Phase 6.

**Do not**: introduce dimensional/analytic budgeting, encumbrance control, forecasting or AI commentary; re-add a stored/materialized actuals table; make the posting warning blocking; move variance or sign logic back into React; or fix unrelated report domains while in this wave.

**Always**: update this file immediately after each implementation so it stays the authoritative status record.
