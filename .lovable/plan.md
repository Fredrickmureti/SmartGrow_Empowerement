# Budget documents — build status

Last updated: 2026-08-23. Continues the approved budget-domain plan
(archived under `.lovable/plan/`).

**Phase 0 — Model truth — DONE.**
`budgets` now carries `budget_code` (per-business unique, auto-generated
`BUD-<fy>-<nnn>`, existing rows backfilled), `approved_by` and `approved_at`
(stamped by `set_budget_status` on draft→active). `currency_code` was already
pinned to the business base currency by `_budgets_defaults`, so the document
can print it as stated fact. New read `get_budget_document_header(budget_id)`
returns identity, scope, approval, revision count and period in one row.

**Phase 1 — Kill the second engine — DONE.**
`buildBudgetVsActual` no longer computes anything. It resolves which budget the
request means (explicit `filters.budgetId`, else the budget in force for the
requested window's fiscal year — never `new Date().getFullYear()`), calls
`get_budget_variance_report`, narrows to the requested periods and lays the rows
out in Revenue / Cost / Other sections with subtotals. Variance is summed, never
recomputed, so the favourable-positive convention stays the RPC's alone.
`_budget_assert_read` now admits `service_role`: scheduled reports run with no
end user, and refusing them would only push them back onto a hand-rolled query.
The caller gate in `render-report` still runs first. Pinned by three new
architecture tests (24 in the suite, green).

**Phase 2 — Budget Schedule dataset — DONE.**
`get_budget_schedule(budget_id)` returns a dense account × accounting-period
grid, sectioned by account nature. A planned zero and an absent line are
different statements and the grid says which.

**Phase 3/4 — PDF / Excel / CSV — DONE via the shared engine.**
Both artifacts are registered in `_shared/reports/columnSpecs.ts`
(`budget_vs_actual` gained an account code and an F/U favourability column;
`budget_schedule` is new), so they render through the existing masthead,
currency policy and pagination in all three media.

**Phase 5 — UI wiring — DONE.**
`BudgetEditPage` exports the Budget Schedule as a SERVER-BUILD config: no
browser rows, branch taken from the budget itself rather than the ambient
switcher. `BudgetReport` stays PREBUILT deliberately — its export replays
exactly the rows on screen. The `budget` / `budget_vs_actual` registry naming
is left alone: `reportType: "budget"` is the saved-view key and renaming it
would orphan saved views.

**Phase 6 — Verify against real data — PARTIAL.**
Verified in the database: `get_budget_variance_report` answers under
`service_role` (3 rows, plan 40,000, actual 2,902) and `get_budget_schedule`
returns the full 12-period grid for `BUD-2026-001`. Not verified by eye: the
rendered PDF / workbook / CSV and a wide budget's pagination. That needs a
signed-in session, which this project cannot mint
(`LOVABLE_BROWSER_AUTH_STATUS = external_unmanaged`).

## Remaining (human, signed in)

1. Open a budget → export the Budget Schedule as PDF, Excel and CSV; confirm
   the masthead states budget code, status, scope and base currency, and that
   revenue and cost are separate sections with a planned surplus line.
2. Run Budget vs Actual on screen, then export it; confirm the two agree and
   that an over-spend reads `U` with a negative variance.
3. Schedule the same report by email; confirm the emailed copy now matches the
   screen (this was the defect).
