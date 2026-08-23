# ANALYTIC ACCOUNTING DOMAIN — FORENSIC ASSESSMENT

## 1. Executive verdict

The Analytic Accounts page is **primarily a CRUD shell with one narrow live producer (Expenses) and zero consumers**. Evidence:

- `analytic_accounts`, `analytic_groups`, `analytic_distributions` exist and are writable from `src/hooks/useAnalyticAccounts.ts`.
- Exactly one server path writes attribution: `post_expense_gl()` inserts one 100% row into `analytic_distributions` (verified in the deployed function body, lines 184–206).
- **No report, view, RPC or edge function reads `analytic_distributions`.** The only readers in the whole repo are `useAnalyticAccounts.getDistributions` / `getAccountBalance`, and neither is called by any page.
- `journal_entry_lines.analytic_account_id` exists and `post_journal_entry_atomic` accepts it, but no posting routine populates it (`select count(*) from journal_entry_lines where analytic_account_id is not null` = 0 of 37).
- `analytic_accounts.balance` is rendered at `src/pages/AnalyticAccounts.tsx:281` but **nothing ever updates it** — it is permanently `0`. That is a UI claiming a number the system does not compute.
- Live data: 0 analytic accounts, 0 groups, 0 distributions.

Verdict: **partial implementation of master data only**; the analytic *business event* (attribution at posting time, aggregation, reporting) does not exist end to end.

## 2. What analytic accounting is (and is not)

- **STD** Financial accounting answers "which GL account moved and by how much"; analytic accounting answers "which internal object (cost center, project, department, product line) is responsible for that amount". It exists because the CoA is a statutory/structural axis and must not be polluted with management axes — otherwise the CoA explodes combinatorially (Rent-Nairobi-ProjectA…).
- **RESEARCH** Odoo models this as *analytic plans* (axes) → *analytic accounts* (values on that axis), with an `analytic_distribution` JSON on each journal item allowing N accounts × percentages per line, plus *distribution models* for rule-based defaults. Dynamics 365 / NetSuite use *financial dimensions* / *segments* attached to the ledger line, with dimension sets and posting-time validation. QuickBooks offers only a flat Class + Location (2 fixed axes, no split by percentage).
- **INFER** The common core across all of them: (a) attribution belongs on the **posted ledger line**, not on the source document alone; (b) multiple axes coexist on one line; (c) one line may split across several values of the *same* axis by percentage summing to 100%; (d) analytic postings **never** alter debits/credits or GL balances — they are a parallel classification of the same amounts.

**What an analytic account is NOT:** a GL account, a second ledger, a project record, a branch, or a tag whose meaning can be edited retroactively.

**Correct lifecycle:** draft → active → restricted-for-new-postings → archived. Never hard-deletable once referenced by a posted line. Code/name may be corrected; **type/axis and business must be immutable once attributed**, because they change the meaning of history.

## 3. Current model is conceptually wrong in one specific way

`analytic_accounts.analytic_type IN (cost_center, project, department, product_line, other)` (CHECK constraint, verified) collapses **the axis and the value into one flat table**. Consequences that are already visible:

- A transaction cannot be attributed to *both* a department *and* a project, because there is one `analytic_account_id` per source row. Real management reporting requires exactly that.
- `analytic_type = 'project'` competes with the real `projects` table. `post_expense_gl` already has to bridge them by string-matching `projects.analytic_account_code = analytic_accounts.code` (lines 185–192) — a fragile join with `LIMIT 1` and no FK.
- `analytic_type = 'department'` competes with the real `departments` table; `product_line` competes with product categorisation.

**Recommendation:** keep a single analytic table but introduce an explicit **plan/axis** parent (`analytic_plans`), so the axis is data, not an enum, and one posted line can carry one value per plan. Do not build a generic N-dimension engine.

## 4. Where the lifecycle actually breaks

CREATE ✅ → CONFIGURE ✅ → ASSIGN: only Expenses (`ExpenseFormFields.tsx` cost-center select) and Purchase Requisitions (`purchase_requisitions.analytic_account_id`, `cost_center`) → TRANSACTION ✅ → **ACCOUNTING ENTRY: attribution is dropped** (`post_expense_gl` builds `v_lines` without `analytic_account_id`, lines 144–162) → ANALYTIC ATTRIBUTION STORED: only in the side table `analytic_distributions`, not on the GL line → AGGREGATION ❌ → REPORTING ❌ → DEACTIVATION: `is_active` exists, is **not enforced anywhere server-side** → HISTORICAL REPORTING ❌.

Split allocation (60/40) is **impossible today**: the write path hardcodes `percentage = 100` and a single account; there is no unique/sum constraint on `analytic_distributions` to make splits safe either.

## 5. Producers / consumers, factually

| Module | Can attribute? | Reaches GL line? | Reversal-safe? |
|---|---|---|---|
| Expenses | Yes (header only) | No | `expense_void` **deletes** the distribution row (migration `20260812123914`) — destroys history instead of reversing |
| Purchase requisitions | Field stored, never posted (pre-GL doc) | n/a | n/a |
| Manual JE | **No UI field** (no `analytic` reference anywhere in `src/features/finance/journal-entries/`) although the RPC supports it | No | n/a |
| Bills, Invoices, SO, PO | Line pickers exist but they set `project_id`/`task_id` via `LineAnalyticsCell`, not analytic accounts | Feeds `project_cost_entries` / `project_revenue_entries`, a **separate** analytic ledger | Unverified |
| Inventory, Fixed assets, Payroll, Banking | No attribution | No | n/a |

**Consumers: none for `analytic_distributions`.** The only working analytic reporting in the product is project profitability, and it reads the *other* ledger, client-side and unbounded: `src/pages/projects/portfolio/Reports.tsx:119` and `Portfolio.tsx:66` do `.select("amount")` then sum in React — subject to the 1000-row PostgREST cap and duplicated logic in `useProjectFinancials.ts`. That is the same defect class found in Budgets.

## 6. Security findings (must be fixed first)

RLS on all three analytic tables is **organization-only** (verified in `pg_policies`): `organization_id IN (select organization_id from user_roles where user_id = auth.uid())`.

- **No `business_id` predicate.** Business isolation is enforced only by the React `.eq("business_id", …)` in `useAnalyticAccounts.ts`. Any authenticated org member can read/insert/update analytic accounts and distributions of **every business in the org**, bypassing the app's business-authorization model. For `analytic_distributions` this leaks amounts and dates — financial data.
- **No branch predicate**, and `analytic_distributions` has no `branch_id` at all, so branch-scoped analytic reporting is impossible.
- **No role predicate on INSERT/UPDATE**: any member, including read-only roles, can write.
- `analytic_accounts_organization_id_code_key` is UNIQUE `(organization_id, code)` — org-wide, so two businesses cannot use the same cost-center code. Wrong grain given the table is per-business.
- Delete is allowed for admins/owners with **`ON DELETE CASCADE` from `analytic_distributions`** — deleting one master row silently destroys posted attribution history.

## 7. Recommended target architecture

1. `analytic_plans (id, org, business, code, name, is_required, applies_to)` — axis as data. Migrate the existing enum values into seeded plans.
2. `analytic_accounts` gains `plan_id`, `status` (draft/active/restricted/archived), `parent_id`; drop `balance` (never materialise a balance — derive it).
3. Attribution lives on **`journal_entry_line_analytics (journal_entry_line_id, analytic_account_id, plan_id, amount, percentage)`**, written *inside* `post_journal_entry_atomic` from the `_lines` JSONB, in the same transaction as the GL line. `analytic_distributions` becomes derived/deprecated, not a second truth.
4. DB invariants: per line, per plan, percentages sum to 100 and signed amounts sum to the line amount; analytic amount never affects debit/credit; archived accounts rejected for new postings.
5. Reversal = **contra analytic rows** produced by `void_journal_entry_atomic`; never `DELETE`.
6. Reporting exclusively through the existing report engine (`supabase/functions/_shared/reportDataEngine.ts` + `ReportRegistry`), server-side SQL, with GL tie-out.

## 8. Dependency-ordered rework plan

- **Phase 0 — Security & integrity (do first, no new features).** Rewrite the 12 RLS policies to be business-scoped and role-aware; change the code uniqueness to `(business_id, code)`; replace the distribution CASCADE with RESTRICT; forbid hard delete of referenced accounts.
- **Phase 1 — Truthful UI.** Remove the fabricated `balance` column from `AnalyticAccounts.tsx` (or derive it server-side). Nothing else in the UI until the data exists.
- **Phase 2 — Model correction.** `analytic_plans`, `status` lifecycle, immutability guards on plan/business after first posting, audit trail.
- **Phase 3 — Attribution at posting.** `journal_entry_line_analytics` + write path inside `post_journal_entry_atomic`; make `post_expense_gl` attribute the GL line rather than the side table; contra-row reversal in `void_journal_entry_atomic`; backfill from `analytic_distributions`.
- **Phase 4 — Producers.** Manual JE line picker, then Bills, then Invoices. Reconcile `LineAnalyticsCell`/`project_cost_entries` into the same ledger instead of running two.
- **Phase 5 — Consumers.** Three reports only: *Analytic Account Statement* (drill-down to JE), *P&L by Analytic Account*, *Budget vs Actual by Analytic Account* — all server-side, period- and branch-aware, each reconciling to the GL total.
- **Phase 6 — Guards.** SQL tests for GL tie-out, 100% distribution, cross-business isolation; architecture test forbidding client-side analytic aggregation.

## 9. Explicitly NOT to build

Unlimited user-defined dimensions; an analytic budget engine separate from `budgets`; analytic *balances* stored on the master row; analytic entries without a GL counterpart (statistical postings); automatic distribution rule engines (Odoo distribution models) — revisit only after Phase 5 shows real demand.

## 10. Out of scope for now

Payroll and inventory attribution, analytic forecasting, multi-currency analytic revaluation, AI narrative on analytic data.
