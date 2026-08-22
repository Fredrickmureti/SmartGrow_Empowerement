# BUDGETS domain — authoritative status (Wave 3)

Last updated: 2026-08-23. This file is the single authoritative record of status.
Wave 1/2 records: `.lovable/plan/budgets-domain-authoritative-status-wave-1-2026-08-22.md`,
`…-wave-2-2026-08-22.md`.

Scope boundary unchanged: **Budget only**. Chart of Accounts, GL, fiscal periods,
analytic accounting and the reporting engine are consumed, never modified.

## Architectural invariants (never regress)

1. A budget is a planning object — it never posts journal entries.
2. Actuals are derived server-side by one RPC; React consumes numbers, never aggregates the ledger.
3. Periods come from `fiscal_periods`; `fiscal_year` / `period_month` are display-only derivations.
4. Variance is favourable-positive, computed in SQL from `accounts.account_type`; income and expense are never netted into one figure.
5. Lifecycle `draft → active → closed` enforced by DB triggers/RPCs; post-activation change is a numbered revision.
6. Account-based budgeting only — no dimensional budgeting, no encumbrance control, no hard posting blocks.
7. A budget's currency is the business base currency; there is no second currency authority.

---

## Phase 1 — Independent verification of the handover (this session)

Method: `pg_proc` inspection (`prosecdef`, `proacl`, `pg_get_functiondef`), row counts on
the live database, source reads of the budget feature, and a full run of the budget
architecture suites.

| Claimed phase | Verdict | Evidence |
| --- | --- | --- |
| 0 — security hotfix | CONFIRMED | all 13 `%budget%` functions are `SECURITY DEFINER` with `SET search_path = public`; `get_period_budget_variance` gates on `user_can_access_business` + `user_has_module_permission('financials','read')` before returning rows |
| 1–3 — model, single actuals authority, lifecycle | CONFIRMED | `_budgets_defaults`, `_budgets_lifecycle_guard`, `_budget_items_normalize`, `set_budget_status` all present; no actuals table |
| 4–5 — reporting engine / integration | CONFIRMED | `get_period_budget_variance` delegates entirely to `get_budget_variance_report`; no second variance definition |
| 6 — regression protection | CONFIRMED | `budgets-single-source-of-truth.test.ts` (20) + `budgets-business-level-gating.test.ts` (8) — 28 assertions green |
| 7 — closed-period planning relaxed | CONFIRMED | `BudgetEditPage` line 447–453 renders a `text-muted-foreground` advisory, draft vs active wording differs; the Wave-2 "cosmetic follow-up" is in fact already done |
| 8 — currency integrity | CONFIRMED | `_budgets_defaults()` raises `23514` on any currency other than `businesses.base_currency` and force-sets the column |
| 9–10 — revision keying, SQL fixtures | CONFIRMED present (`apply_budget_revision`, `supabase/tests/budgets_variance_engine_test.sql`); fixture re-run scheduled in Phase 14 below |
| 11 — browser acceptance | NOT STARTED, as declared |

### New defects found during verification (not in the previous plan)

- **FACT / SECURITY-HYGIENE — read RPCs are executable by `anon`.** `proacl` shows
  `anon=X` on `get_budget_variance_report`, `get_period_budget_variance` and
  `budget_fiscal_months`; `check_budget_variance` additionally carries a bare
  `PUBLIC` EXECUTE grant. No data leaks (each body rejects `auth.uid() IS NULL` or
  fails the access gate), but the surface violates the stated
  `authenticated + service_role` rule and lets unauthenticated callers probe the
  functions. Must be revoked.
- **FACT / PRESENTATION DEFECT — the Analysis chart nets revenue and cost.**
  `BudgetEditPage` builds `chartData` as `expenseByMonth[i].actual + incomeByMonth[i].actual`
  (same for budget and variance), so one bar mixes credit-normal revenue with
  debit-normal cost. That breaches invariant 4 at the presentation layer and the
  resulting bar has no accounting meaning. The hook already exposes a correct
  `net` total and separate income/expense series; the chart must plot those, not a sum.
- **FACT — the database holds zero budgets, zero budget lines, zero revisions and
  17 journal entries.** Phase 11 acceptance therefore requires seeding through the UI
  seams first; there is no existing dataset to verify against.

Nothing verified in phases 0–10 needs reopening.

---

## Ordered remaining work

### Phase A — Revoke the anon/PUBLIC execute grants (blocking, tiny)
One single-purpose migration: `REVOKE EXECUTE … FROM anon, PUBLIC` on
`get_budget_variance_report`, `get_period_budget_variance`, `budget_fiscal_months`,
`check_budget_variance`; re-`GRANT` to `authenticated`, `service_role`.
Validation: re-query `pg_proc.proacl` for the whole `%budget%` family and assert
only `authenticated`/`service_role`/owner appear.

### Phase B — Fix the netted Analysis chart
`BudgetEditPage` plots grouped revenue and cost series (or the hook's `net` line),
never a summed bar. Add an assertion to `budgets-single-source-of-truth.test.ts`
that no budget component adds an income series to an expense series.

### Phase C — Phase 11 browser acceptance (the previously stalled phase)
Drive the live preview with Playwright, seeding only through UI seams:
1. Create a draft budget with lines; confirm the closed-fiscal-year notice is advisory.
2. Activate it; confirm line edits are refused and the revision path is offered.
3. Apply a numbered revision; confirm it is keyed to the right `fiscal_period_id`
   and the report moves.
4. `/reports/budget`: totals render, no console errors, favourable-positive badges
   correct on both income and expense rows, drill-down opens matching journal lines.
5. Period-close screen shows the same numbers as `/reports/budget` for that period.
6. Currency badge equals the business base currency on every surface.
Any mismatch reopens the owning phase rather than being patched in the UI.

### Phase D — SQL isolation ratchet
`supabase/tests/budgets_isolation_test.sql`: business A cannot read B's budgets,
lines or revisions; cross-org `check_budget_variance` and `get_budget_variance_report`
raise `42501`. Run inside a transaction and roll back.

### Phase E — ADR + memory
ADR covering the budget seams (single actuals RPC, favourable-positive convention,
lifecycle, currency authority, revision keying); `mem/features/budgets-domain.md`
referenced from `mem/index.md`.

### Phase F — Closing sweep
Re-run both architecture suites, `budgets_variance_engine_test.sql`, the new
isolation fixture and a typecheck; re-query `proacl` after every redefinition.

Out of scope for this wave: dimensional/analytic budgeting, encumbrance control,
forecasting, AI commentary, cash-flow budgeting.

---

## Instructions for the next agent

1. Verify before you build; record the verdict here with evidence.
2. A failed claim reopens its phase — never weaken a test to make it pass.
3. Every SQL change ships as its own small, single-purpose migration; every new
   function is `SECURITY DEFINER` with a pinned `search_path`, granted to
   `authenticated` + `service_role` only.
4. Update this file after every completed step.
