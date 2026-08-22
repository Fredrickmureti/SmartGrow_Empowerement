# BUDGETS domain — authoritative status (wave 1)

Last updated: 2026-08-22 — Phase 4 defects closed and verified, Phase 5 closed, Phase 6 delivered.
Background findings: `.lovable/plan/budgets-domain-rework-contract-wave-1-2026-08-22.md`.
Previous handover verdict: `.lovable/plan/budgets-domain-authoritative-status-wave-1-2026-08-22.md`.
This file is now the authoritative execution record.

Scope boundary unchanged: Budget only. Chart of Accounts, GL, fiscal periods, analytic accounting and the reporting engine are consumed, not modified.

Architectural invariants (do not regress):
1. A budget is a planning object — it never posts journal entries.
2. Actuals are derived server-side by one RPC. React consumes numbers and never aggregates the ledger.
3. Periods come from `fiscal_periods`; `fiscal_year`/`period_month` are display-only derivations.
4. Variance is favourable-positive, computed in SQL from `accounts.account_type`; income and expense are never netted into one headline figure.
5. Lifecycle `draft → active → closed` is enforced by DB triggers/RPCs; post-activation change is a numbered revision, never an in-place edit.
6. Budgeting stays account-based — no dimensional/analytic budgeting, no encumbrance control, no hard posting blocks.

---

## Phase status

| Phase | Status |
| --- | --- |
| 0 — Security hotfix | **DONE, verified** (previous session + re-confirmed by isolation probe below). |
| 1 — Domain model | **DONE, verified.** |
| 2 — Actuals RPC | **DONE (superseded).** No stored actuals table exists; nothing in `src/` references one. |
| 3 — Lifecycle & editing | **DONE, verified live** — see lifecycle evidence below. |
| 4 — Reporting | **DONE, verified against a live fixture** (D1/D2/D3 closed). One residual verification item listed below. |
| 5 — Integration & cleanup | **DONE** (D4/D5/D6/D7 closed). |
| 6 — Regression protection | **DONE for architecture invariants**; DB-level accounting fixtures are executed manually, not yet in CI (see "Pending"). |

---

## What was implemented and verified

**Phase 4 — reporting (migration + frontend)**
- `public.budget_fiscal_months(_business_id, _fiscal_year)` — single authority resolving a budget's twelve monthly periods from the `period_type='year'` fiscal period, falling back to `businesses.fiscal_year_start`. Returns `period_ordinal` for fiscal-order presentation. **D2 closed.**
- `public._budget_items_normalize` stamps `budget_items.fiscal_period_id` from that same authority.
- `public.get_budget_variance_report` rebuilt: ledger filtered by `ledger_visible_journal_statuses()` (posted **and** reversed) — **D1 closed**; plan↔ledger joined on `fiscal_period_id` — **D3 closed**; sample/closing/opening entries excluded; `period_ordinal` exposed.
- `src/hooks/useBudgetVsActual.ts` derives its month axis from `period_ordinal` (no calendar assumptions), and does no aggregation.

**Phase 5 — integration**
- New `public.get_period_budget_variance(_fiscal_period_id)` — security-gated, resolves the business's active budget and delegates to `get_budget_variance_report`, so the period-close screen and the budget report cannot diverge.
- `src/hooks/useFiscalPeriodDetail.ts`: the direct `budget_items` query and the `Math.abs`/unfavourable-positive local computation were deleted and replaced by that RPC. `FiscalPeriodDetail.tsx` renders the DB-supplied `favourable` flag and handles a null variance percentage. Codemod residue in the touched blocks cleaned.
- `src/lib/finance/budgetConsumption.ts` is the single authority for which journal sources consume budget; `useGLPosting.ts` consumes it, so the posting warning is suppressed for closing/opening/migration/reversal sources and otherwise agrees with the report.

**Phase 6 — regression protection**
- `src/test/architecture/budgets-single-source-of-truth.test.ts` — 20 assertions: no ledger aggregation in any budget consumer, no direct `budget_items` read outside the budget feature, no client-side variance/sign logic, no re-introduction of a stored actuals surface. Budget suites green (28 assertions across two files).

**Live verification run (purpose-built fixture on Joshua Holdings, created and deleted in-session)**
- Period authority: `budget_fiscal_months(…, 2026)` returns 12 months, ordinals 1–12, sourced from the fiscal-year row.
- Plan lines inserted with only `period_month` were stamped with the correct `fiscal_period_id` by the normalizer.
- **Parity:** report actuals `5010 = 1,092.00` and `4010 = 1,560.00` for Aug-2026 match `get_account_movements` over the same window exactly.
- **Signs:** expense over plan and income under plan both `favourable = false`; unspent Sep plan `favourable = true`; income and expense never netted.
- **Unbudgeted spend surfaced:** account `6410` (250.00, no plan line) returned with `is_unbudgeted = true`.
- **No divergence:** `get_period_budget_variance` for Aug-2026 returned figures identical to the report; it correctly returns nothing while the budget is `draft` and data once `active`.
- **Isolation:** both RPCs raise `42501` for a user outside the owning organisation.
- **Lifecycle (incidental proof):** editing lines on an active budget was rejected ("record a budget revision"), `active → draft` was rejected, and deleting a non-draft budget was rejected.
- Fixture fully removed afterwards; all `budgets`/`budget_items` triggers confirmed re-enabled.

---

## Pending (carry into the next wave)

1. **Non-January fiscal year end-to-end proof.** The fallback and year-window logic in `budget_fiscal_months` is written and unit-reviewed, but the only tenant in this database starts in January. Needs a seeded business with `fiscal_year_start = 7` and July–June `fiscal_periods`.
2. **Reversal and branch-scope fixtures.** Static proof exists (the function uses `ledger_visible_journal_statuses()` and scopes by branch), but no live fixture posts-then-reverses an entry or compares a branch budget against a company-wide one.
3. **CI wiring of the DB fixtures.** Items 1–2 and the Phase 4 parity script currently run by hand; they should become repeatable seeded tests.
4. **Browser pass** over `/reports/budget` and the budget edit page: console clean, badges follow the favourable-positive convention, drill-down opens the right journal lines.
5. Six pre-existing failures in unrelated report suites (Partner Ledger, Journal, Cash Flow, Audit Trail, ReportPageLayout) remain out of scope for this wave.

---

## Instructions for the next agent

1. **Verify before you build.** Re-run the budget architecture suites, then re-read `get_budget_variance_report`, `get_period_budget_variance`, `budget_fiscal_months` and `_budget_items_normalize` with `pg_get_functiondef` and confirm: visible-status ledger filter, `fiscal_period_id` join, sample/closing exclusion, security gates present in both RPCs. Confirm `useFiscalPeriodDetail.ts` and `useBudgetVsActual.ts` still contain no aggregation or sign logic.
2. **Then resume at Pending item 1**, the non-January fiscal-year fixture, followed by 2 and 3 — that is the next logical milestone (closing out Phase 6 with real accounting fixtures in CI). Do item 4 last as the acceptance pass.
3. Any live fixture must be created and deleted in-session as done here; never verify against untouched tenant data, and always re-enable triggers after a cleanup that disables them.

**Do not**: introduce dimensional/analytic budgeting, encumbrance control, forecasting or AI commentary; re-add a stored/materialised actuals table; make the posting warning blocking; move variance or sign logic into React; or repair the six unrelated failing report assertions while in this wave.

**Always**: update this file immediately after each slice so it stays the authoritative status record.
