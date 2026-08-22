# BUDGETS domain — authoritative status (Wave 2)

Last updated: 2026-08-22 23:20 UTC.
This file is the single authoritative record of project status. Wave 1 contract and
investigation notes are archived at
`.lovable/plan/budgets-domain-authoritative-status-wave-1-2026-08-22.md`.

Scope boundary unchanged: **Budget only**. Chart of Accounts, GL, fiscal periods,
analytic accounting and the reporting engine are consumed, never modified.

## Architectural invariants (never regress)

1. A budget is a planning object — it never posts journal entries.
2. Actuals are derived server-side by one RPC. React consumes numbers, never aggregates the ledger.
3. Periods come from `fiscal_periods`; `fiscal_year` / `period_month` are display-only derivations.
4. Variance is favourable-positive, computed in SQL from `accounts.account_type`; income and expense are never netted.
5. Lifecycle `draft → active → closed` is enforced by DB triggers/RPCs; post-activation change is a numbered revision, never an in-place edit.
6. Budgeting stays account-based — no dimensional budgeting, no encumbrance control, no hard posting blocks.
7. A budget's currency is the business's base currency. There is no second currency authority.

---

## Completed and verified

| Phase | Work | Verification evidence |
| --- | --- | --- |
| 0 | Security hotfix on `check_budget_variance` | `pg_get_functiondef`: business/branch/org parentage gates, `finance_can_read_scope*`, ledger-visible statuses only |
| 1 | Domain model (`budget_status`, lifecycle guard, `fiscal_period_id` FK, revisions) | schema inspection |
| 2 | Single actuals authority | `budget_actuals` / `recalculate_budget_actuals` dropped; zero references in `src/` |
| 3 | Lifecycle & editing seams | `_budget_items_normalize` enforces transitions; RPC-only writes |
| 4 | Reporting engine — D1/D2/D3 closed | `get_budget_variance_report` uses `ledger_visible_journal_statuses()`, resolves periods via `budget_fiscal_months` (fiscal-year window, non-January safe), joins plan↔ledger on `fiscal_period_id` |
| 5 | Integration & cleanup (D4–D7) | no second variance computation in React; `useFiscalPeriodDetail` consumes `get_period_budget_variance`; posting warning agrees with the report |
| 6 | Regression protection (frontend) | `budgets-single-source-of-truth.test.ts` + `budgets-business-level-gating.test.ts` — 28 assertions green |
| 7 | Closed-period planning relaxed | `_budget_items_normalize` allows draft writes in closed periods; `BudgetCreatePage` / `BudgetEditPage` show advisory notices instead of hard blocks |
| 8 | Currency integrity | `_budgets_defaults()` trigger forces `budgets.currency_code = businesses.base_currency` (rejects mismatch, `23514`); existing rows backfilled; `BudgetReport` labels from `useCurrency().baseCurrency` |
| 9 | Revision keying | `apply_budget_revision` keys lines on `fiscal_period_id`, resolving `period_month` through `budget_fiscal_months` when only the label is supplied; `useBudgets.applyRevision` carries the field |
| 10 | CI accounting fixtures | `supabase/tests/budgets_variance_engine_test.sql` — scenarios A–K (July fiscal-year ordinals, currency derivation, draft vs active vs closed writes, favourable-positive variance, unbudgeted-expense detection, cross-business isolation). Executed against the remote database inside a transaction and rolled back; all scenarios passed |

---

## Currently active phase

**Phase 11 — Browser acceptance pass.** Not started. Everything before it is closed.

Scope of Phase 11 (must all be done before the phase is called complete):
1. Seed a disposable fixture budget (non-January fiscal year preferred) through the UI seams only — no direct table writes.
2. `/reports/budget`: totals render, no console errors, favourable-positive badges correct on both income and expense rows, drill-down opens the matching journal lines.
3. Budget create/edit: draft authoring inside a closed fiscal year succeeds with an advisory (not destructive) notice; activation then freezes closed-period lines.
4. Activate the budget and apply a revision — confirm the numbered revision is recorded against the right `fiscal_period_id` and the report moves accordingly.
5. Period-close screen (`useFiscalPeriodDetail`) shows the same numbers as `/reports/budget` for the same period.
6. Confirm the currency badge equals the business base currency everywhere the plan is shown.

Known cosmetic follow-up inside Phase 11: closed-period notices on `BudgetEditPage` must be `text-muted-foreground` in draft mode, `text-destructive` only when the budget is active/closed.

## Pending after Phase 11

- **Phase 12 — SQL isolation ratchet.** Move the cross-tenant assertions out of the fixture file into a dedicated `supabase/tests/budgets_isolation_test.sql`: business A cannot read B's budget, lines or revisions; cross-org `check_budget_variance` and `get_budget_variance_report` raise `42501`.
- **Phase 13 — ADR + memory.** ADR documenting the budget seams (single actuals RPC, favourable-positive convention, lifecycle, currency authority, revision keying); add `mem/features/budgets-domain.md` and reference it from `mem/index.md`.
- **Phase 14 — closing sweep.** Re-run the budget architecture tests, the SQL fixtures and a typecheck; re-query `pg_proc.proacl` for the whole budget function family to confirm `authenticated` + `service_role` only after every Phase 11–13 redefinition.

Out of scope for this wave: dimensional/analytic budgeting, encumbrance control, forecasting, AI commentary, cash-flow budgeting.

---

## Instructions for the next agent

1. **Verify before you build.** Do not trust this table. Re-derive each "completed" claim from the live database and the codebase: `pg_get_functiondef` on `get_budget_variance_report`, `get_period_budget_variance`, `apply_budget_revision`, `_budget_items_normalize`, `_budgets_defaults`; `pg_proc.proacl` for the budget family; and a repo grep proving no React file aggregates `journal_entry_lines` or reads `budget_items` outside the budget feature. Run the two budget architecture test files and `supabase/tests/budgets_variance_engine_test.sql`. Record the verdict in this file with evidence, as the previous handovers did.
2. If a claim fails verification, **reopen that phase and fix it first** — never paper over it by weakening a test.
3. Once verification is green, **resume at Phase 11** (browser acceptance), then 12 → 13 → 14 in order. Do not start unrelated domains, do not leave a phase half-landed, and do not ship a workflow whose UI, RPC and test story are not all complete.
4. Every SQL change ships as its own small, single-purpose migration; every new function is `SECURITY DEFINER` with a pinned `search_path`, granted to `authenticated` + `service_role` only, and every new public table ships GRANTs in the same migration.
5. Update this file after every completed step — it is the authoritative status of the project.
