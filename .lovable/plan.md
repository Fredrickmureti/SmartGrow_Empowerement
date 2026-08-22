# BUDGETS domain — authoritative status (wave 2)

Last updated: 2026-08-22 (late) — handover verification of wave 1 complete. Wave 2 defined below.
Background findings: `.lovable/plan/budgets-domain-rework-contract-wave-1-2026-08-22.md`.
Wave-1 record: `.lovable/plan/budgets-domain-authoritative-status-wave-1-2026-08-22.md`.
This file remains the authoritative execution record.

Scope boundary unchanged: Budget only. Chart of Accounts, GL, fiscal periods, analytic accounting and the reporting engine are consumed, not modified.

Architectural invariants (do not regress):
1. A budget is a planning object — it never posts journal entries.
2. Actuals are derived server-side by one RPC. React consumes numbers and never aggregates the ledger.
3. Periods come from `fiscal_periods`; `fiscal_year`/`period_month` are display-only derivations.
4. Variance is favourable-positive, computed in SQL from `accounts.account_type`; income and expense are never netted into one headline figure.
5. Lifecycle `draft → active → closed` is enforced by DB triggers/RPCs; post-activation change is a numbered revision, never an in-place edit.
6. Budgeting stays account-based — no dimensional/analytic budgeting, no encumbrance control, no hard posting blocks.

---

## Phase 1 — Independent verification of wave 1 (this session)

Method: `pg_get_functiondef` on every claimed object, `pg_policy`/`pg_constraint`/`pg_indexes` reads, source reads of the hooks and report, and a full run of the budget architecture suites.

| Wave-1 claim | Verdict |
| --- | --- |
| Phase 0 security hotfix | **CONFIRMED.** Both RPCs are `SECURITY DEFINER … SET search_path = public` and gate on `user_can_access_business` + `user_has_module_permission('financials','read')` (via `_budget_assert_read` / inline in `get_period_budget_variance`). |
| Phase 1 domain model | **CONFIRMED.** `budgets` (business_id, branch_id, fiscal_year, status enum, currency_code), `budget_items` (fiscal_period_id FK, business_id), `budget_revisions` + `budget_revision_lines`. Unique indexes enforce one active budget per (business, branch, fiscal_year) and unique budget names per scope. |
| Phase 2 no stored actuals | **CONFIRMED.** No actuals table exists; nothing in `src/` references one. |
| Phase 3 lifecycle | **CONFIRMED in code.** `_budgets_lifecycle_guard`, `_budgets_defaults`, `_budget_items_normalize` and `set_budget_status` are attached as triggers/RPCs; the normalizer rejects line writes on `active` (unless inside `apply_budget_revision`) and on `closed`. |
| Phase 4 reporting | **CONFIRMED line by line.** `get_budget_variance_report` filters `je.status = ANY(ledger_visible_journal_statuses())`, excludes closing/opening/sample, joins plan↔ledger on `fiscal_period_id`, scopes by `je.business_id` and `budgets.branch_id`, computes favourable-positive variance from `account_type`, and limits unbudgeted rows to income/expense with non-zero activity. `budget_fiscal_months` resolves the year window from the `period_type='year'` row with a `businesses.fiscal_year_start` fallback. |
| Phase 5 integration | **CONFIRMED.** `get_period_budget_variance` delegates to the report; `useFiscalPeriodDetail.ts` and `useBudgetVsActual.ts` contain no ledger aggregation and no sign logic (client only sub-totals rows the DB already signed — presentational). `src/lib/finance/budgetConsumption.ts` is the single consumption authority used by `useGLPosting.ts`. |
| Phase 6 regression protection | **CONFIRMED for architecture.** `budgets-single-source-of-truth.test.ts` (20) + `budgets-business-level-gating.test.ts` (8) — 28 assertions, all green this session. |
| Pending items 1–4 | **CONFIRMED still open.** No `supabase/tests/budgets_*_test.sql` exists (147 sibling pgTAP-style files do). The database holds exactly one business (Joshua Holdings, `fiscal_year_start` NULL, base currency KES), one 2026 fiscal year, 12 monthly periods, and **zero** `budgets`/`budget_items` rows — so no non-January, branch or reversal fixture has ever been persisted. |

**Verdict: wave 1 is genuine.** No claim was found to be overstated. Three new defects were found that wave 1 did not record.

---

## New defects found during verification (FACT unless marked)

**D8 — a budget cannot be planned over a closed accounting period.**
`_budget_items_normalize` raises `23514` whenever the target `fiscal_periods.status <> 'open'`, for *every* line write including a brand-new **draft** budget. `BudgetEditPage.tsx:154,192` mirrors the block in the UI.
*Domain standard:* a period lock governs **postings**, not plans. Odoo, NetSuite and Dynamics all allow a budget to be authored across periods that are locked for posting; QuickBooks likewise lets you build a budget for a prior year.
*Consequence:* a tenant that closes January cannot afterwards create the year's budget, cannot copy last year's budget for comparison, and cannot back-load an approved plan during onboarding.
*Fix:* keep the closed-period block for `active` budgets (a plan already in force must not be retro-edited outside a revision), and drop it for `draft` budgets.

**D9 — budget currency is unconstrained but the report is rendered in base currency.**
`budgets.currency_code` has no FK and no check; `_budgets_defaults` only *defaults* it to `businesses.base_currency`. Actuals come from `journal_entry_lines.debit/credit`, which are base-currency (transaction currency lives in `original_currency`/`original_debit`). `BudgetReport.tsx` formats every figure with `baseCurrency` while rendering `budget.currency_code` as a badge (line 240).
*Consequence:* if `currency_code` ever diverges from base currency, plan and actual are compared across currencies and the badge lies about the figures.
*Fix (recommended):* a budget is a base-currency plan. Add a DB check/trigger forcing `currency_code = businesses.base_currency`, and make the report label read from the same authority instead of showing a second, possibly contradictory, currency.
*Rejected alternative:* multi-currency budgeting with FX translation at report time — no demonstrated demand, and it duplicates the FX resolver's remit.

**D10 — `apply_budget_revision` keys lines by `period_month`, not `fiscal_period_id`.**
Lines 66–89 of the RPC look up and upsert on `(budget_id, account_id, period_month)`, matching the `budget_items_budget_id_account_id_period_month_key` unique constraint. Invariant 3 states `fiscal_period_id` is the join key and `period_month` is display-only; the revision path therefore contradicts the invariant the report depends on.
*Consequence today:* none observable — inside one fiscal year each monthly period has a distinct calendar month. It is a latent trap: any future support for 13-period or 52-week calendars silently corrupts revisions.
*Fix:* accept `fiscal_period_id` in the payload (falling back to month for compatibility), key the upsert on it, and add the matching unique index.

**D11 (INFERENCE) — `budget_items` has no audit trail.** Only `budgets` carries `trg_budgets_audit`. Line-level history exists solely for post-activation revisions; draft editing is unaudited. Acceptable for draft (a draft has no authority), so this is recorded, not scheduled.

---

## Wave 2 — ordered execution

Dependency order: correctness fixes land before the fixtures that must prove them.

**Phase 7 — closed-period planning (D8).** Migration reworking `_budget_items_normalize` so the period-status block applies only when the budget is `active` or `closed`; UI guard in `BudgetEditPage.tsx` relaxed to match; a draft budget over a closed period is authorable and reportable. Validation: pgTAP asserting draft-write allowed / active-write rejected / revision path still audited.

**Phase 8 — budget currency integrity (D9).** Migration adding the base-currency invariant on `budgets`; `BudgetReport.tsx` sources its currency label from one authority. Validation: pgTAP rejecting a divergent `currency_code`; architecture assertion that the report never renders two currencies.

**Phase 9 — revision keyed on the accounting period (D10).** Migration: new unique index on `(budget_id, account_id, fiscal_period_id)`, `apply_budget_revision` accepting and keying on `fiscal_period_id`; `useBudgetRevisions.ts` / edit page send it. Validation: pgTAP round-trip proving revision lines bind to the period row.

**Phase 10 — DB accounting fixtures in CI (wave-1 pending 1–3).** New `supabase/tests/budgets_variance_engine_test.sql` following the house pgTAP pattern, seeding and tearing down inside the test:
- a business with `fiscal_year_start = 7` and July–June periods → `budget_fiscal_months` returns ordinals 1–12 starting in July, and the report charts in fiscal order;
- post → reverse a journal entry → the reversal is visible (`ledger_visible_journal_statuses`) and the actual nets to zero;
- a branch budget vs a company-wide budget over the same ledger → branch figures exclude other branches;
- cross-tenant probe → both RPCs raise `42501`;
- parity of report actuals against `get_account_movements` over the same window.

**Phase 11 — acceptance pass.** Browser run over `/reports/budget`, the budget list, create, edit and revision flows: console clean, favourable-positive badges, drill-down opens the correct journal lines, closed-period draft authoring works end to end.

Out of scope for wave 2 (unchanged): dimensional/analytic budgeting, encumbrance control, forecasting, AI commentary, a stored actuals table, blocking posting warnings, and the six pre-existing failures in unrelated report suites.

---

## Execution status

| Phase | Status |
| --- | --- |
| 0–6 (wave 1) | DONE — independently re-verified 2026-08-22. |
| 7 — closed-period planning | NOT STARTED. |
| 8 — currency integrity | NOT STARTED. |
| 9 — revision period keying | NOT STARTED. |
| 10 — DB fixtures in CI | NOT STARTED. |
| 11 — acceptance pass | NOT STARTED. |

Update this file immediately after each slice.
