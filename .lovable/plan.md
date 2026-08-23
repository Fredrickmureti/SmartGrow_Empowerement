# Budget domain — what a Budget is here, and what its artifacts should be

Last updated: 2026-08-23. Supersedes the Wave-3 status plan (archived).

This plan is the handoff. It records what the code and database actually do,
what is broken, what a Budget artifact should be in *this* system, and the work
to get there.

---

## Part 1 — What the system actually implements (evidence)

### 1.1 The data model

`budgets` (verified against `information_schema`):

| Column | Note |
|---|---|
| `id`, `organization_id`, `business_id` | tenant + company scope |
| `branch_id` (nullable) | NULL = company-wide budget; set = branch budget |
| `name` (text) | free text; **there is no budget code/number** |
| `fiscal_year` (int) | the *only* period anchor; no start/end dates on the budget |
| `description` | free text |
| `status` (`budget_status`) | enum is exactly `draft | active | closed` |
| `currency_code` (text, nullable) | **stored, never read by any UI** (see 1.5) |
| `created_by`, `created_at`, `updated_at` | no `approved_by`, no `approved_at`, no owner |

`budget_items`: `budget_id`, `account_id`, `period_month` (int),
`fiscal_period_id` (nullable but trigger-backfilled), `budgeted_amount`
(numeric), `notes`, `business_id`.

`budget_revisions` / `budget_revision_lines`: `revision_number`, `reason`,
`note`, `created_by`, and per-line `previous_amount` / `new_amount`.

Live data: 1 budget ("2026 Oprating budget", FY2026, `active`, branch-scoped,
`currency_code = KES`), 1 line, 0 revisions.

### 1.2 What the trigger `_budget_items_normalize` enforces

- `fiscal_period_id` is derived from `budget_fiscal_months(business, fy)` when
  omitted, and `period_month` is then *re-derived from the period*, so the
  accounting calendar — not the calendar month — is authoritative.
- Account must belong to the same business.
- `budgeted_amount` must be `>= 0`. **Negative budget lines are impossible**:
  direction is carried by account nature, never by sign.
- A `closed` budget's lines are read-only; an `active` budget's lines can only
  change through `apply_budget_revision` (guarded by
  `current_setting('app.budget_revision')`).
- A draft may be authored into closed periods (prior-year plans, back-loads);
  once in force, a closed period's plan line is frozen.

### 1.3 Dimensions actually supported

Account **and branch**. That is all. There is no department, cost centre,
class, or project dimension on a budget line, and no analytic dimension table
in the budget domain. (`projects` carry their own budget figure; that is a
different concept and is out of scope here.)

### 1.4 Actuals, and how variance is computed

The authoritative engine is the SQL RPC `get_budget_variance_report(budget_id)`:

- actuals come from `journal_entry_lines` where
  `je.status = ANY (ledger_visible_journal_statuses())` and the entry is not
  closing / opening / sample;
- branch-matched to the budget's own `branch_id` (NULL budget = all branches);
- period-matched on `fiscal_period_id`, never on a month number;
- account-signed: asset/expense = debit − credit, otherwise credit − debit;
- **variance is favourable-positive by account nature** — under-spend on a cost
  account and over-earn on a revenue account both read positive;
- `variance_percent` is NULL when the plan is zero (no divide-by-zero);
- unbudgeted actuals are surfaced, but only for income/expense accounts.

There are **no commitments or encumbrances**. `src/lib/finance/budgetConsumption.ts`
is only a posting-time *warning* filter (excludes closing / opening / migration /
reversal sources); it does not reserve budget.

There is **no forecasting** and no prior-year comparative in the engine.

### 1.5 Currency

`budgets.currency_code` appears exactly once in `src` — as a field on the
TypeScript row type (`src/hooks/useBudgets.ts:19`). Nothing reads it.
`BudgetReport.tsx` labels and formats every figure with `baseCurrency` from
`useCurrency()`. Since actuals are ledger figures in base currency and there is
no conversion anywhere, the *true* invariant is: **a budget is denominated in
the company's base currency**. `currency_code` is a stored field that promises a
capability the engine does not have.

### 1.6 The reporting / export surface today

- `src/pages/reports/BudgetReport.tsx` — Budget vs Actual on screen, fed by
  `useBudgetVsActual` → the authoritative RPC. Correct.
- Its `getExportConfig()` (`BudgetReport.tsx:204-216`) omits `organizationId`,
  `dateFrom` and `dateTo`, so `isServerBuildConfig()` is false and
  `render-report` runs in PREBUILT mode — the export replays the browser's rows.
  Today that is accidentally the *safe* path.
- `src/features/finance/budgets/BudgetEditPage.tsx` — the budget-authoring
  screen — has **no export wiring of any kind**. The plan itself, the thing that
  gets approved and circulated, cannot be produced as a document.

---

## Part 2 — The defects

### D1 (critical) — two disagreeing Budget vs Actual engines

`supabase/functions/_shared/reportDataEngine.ts:1551` `buildBudgetVsActual` is a
second, independent implementation. Against the RPC it:

- selects the budget by `new Date().getFullYear()` and `status='active'`,
  `limit 1` — ignores which budget the user asked for, and breaks for any fiscal
  year that is not the calendar year;
- **ignores `branch_id`** — a branch budget is compared against company-wide
  actuals;
- **ignores `fiscal_period_id`** — collapses to account totals, losing periods;
- computes `variance = actual − budgeted` for **every** account type, i.e. the
  opposite sign convention to the RPC for expenses. Overspending reads positive.

It is reachable from `supabase/functions/process-scheduled-reports/index.ts:244`
and from the `render-report` server-build path
(`render-report/index.ts:170`). **A scheduled or emailed Budget vs Actual today
reports different, wrongly-signed numbers than the screen.**

### D2 — there is no Budget document

Only the variance *report* has an artifact. A budget is an approved instrument;
a controller cannot hand anyone the plan.

### D3 — the model cannot state approval or version

No budget code, no `approved_by` / `approved_at`, no version label. A formal
document cannot honestly print "Version 2, approved by X on Y". Revisions exist
as an audit log but nothing marks a revision as *the* approved edition, and no
report can be run "as of revision N".

### D4 — `currency_code` is a false promise (see 1.5).

### D5 — identifier drift

`reportType` is `"budget"` in `ReportRegistry.ts:453` and `"budget_vs_actual"`
in the export config and edge-function union. Cosmetic, but it is why D1 went
unnoticed.

## Verdict

**Category C + D, separated.**

- The *variance engine* (RPC) is architecturally sound — category C: the data is
  right, the second server-side implementation and the missing document are
  presentation/plumbing failures.
- The *budget entity* has genuine model gaps — category D: approval identity,
  version identity and currency semantics must be settled before a formal
  document can make truthful statements.

---

## Part 3 — What a Budget is in this ERP, and the artifacts it justifies

Evidence-based definition: **a Budget here is a company- or branch-scoped,
fiscal-year, month-phased, account-level operating plan in base currency, with a
draft → active → closed lifecycle and an amendment trail.** It is a *management
planning and control* instrument, not a budgetary-control (encumbrance)
mechanism, because nothing reserves funds.

Mature systems (NetSuite: Budget Income Statement vs Budget vs Actual; Dynamics
365 / Business Central: budget entry vs Trial Balance/Budget; Odoo: budget
management vs Budget Report) all separate the *plan* from the *comparison*. This
system's model supports exactly that split and nothing wider — so exactly two
artifacts are justified, not five:

**Artifact A — Budget Schedule** (the plan; new)
Identity → scope → plan → totals → amendment trail. No actuals.

**Artifact B — Budget vs Actual** (the comparison; exists, needs unification)
Plan, actual, variance, favourability, by account within revenue / cost /
other, either summarised by account or phased by period.

Explicitly rejected as unsupported by the model, and *why*:

- Budget Performance / consumption-and-commitment view — no encumbrance model.
- Departmental or project budget report — no such dimension on a budget line.
- Multi-currency budget report — no budget FX rate, no conversion.
- Rolling forecast / prior-year comparative — no forecast entity.
- An executive-summary-only artifact — it would restate Artifact B's totals
  with no new information.

### Visual grammar

Not the invoice grammar, not the trial-balance grammar. The hierarchy is:

```text
Budget identity      name, FY, status, version/as-of, base currency
Scope                legal entity, branch or "All branches"
Control block        prepared on/by, revision count, last amendment
Plan summary         total revenue, total cost, planned surplus/deficit
Revenue section      accounts, period columns, section total
Cost section         accounts, period columns, section total
Net result           planned surplus/deficit
Amendment trail      revision no., date, reason, net effect
```

Budget vs Actual keeps this skeleton but replaces the period columns with
Plan / Actual / Variance / Var % and adds a favourability column, keeping
revenue and cost as separate sections that are never netted into one bar or one
variance.

### PDF / Excel / CSV are three different artifacts

| | Purpose | Content |
|---|---|---|
| **PDF** | approval, circulation, archive | Landscape. Full masthead + control block. Sections with repeated column headers on every page, subtotal rows kept with their section, grand total never orphaned. 12 period columns get a "Q1..Q4 + Total" fold when the account count would otherwise force an unreadable page; the full month grid stays in Excel. Zeros as `—`, negatives in parentheses, base-currency code in the column header, not in every cell. Footer: page x of y, budget name, status, revision, generation timestamp. |
| **Excel** | analysis | Multiple sheets, each with a stated purpose: `Summary` (totals + net result), `Budget Schedule` (account × period grid, **live SUM formulas** for row and column totals so a planner can flex a cell), `Budget vs Actual` (only when actuals are requested), `Parameters` (budget id, scope, FY, currency, revision, generated-at — so a workbook found on a shared drive is self-describing). Amounts are values; totals are formulas. No merged cells, freeze panes on headers, autofilter on the detail sheet. |
| **CSV** | interchange | One canonical, flat, fully-qualified row per account × period. No sections, no subtotals, no blank spacer rows, no currency symbols, no parentheses — ISO dates and plain signed decimals. Columns: `budget_id, budget_name, fiscal_year, status, revision_number, business_id, branch_id, branch_name, currency_code, account_id, account_code, account_name, account_type, fiscal_period_id, period_start, period_end, budgeted_amount` plus, in the vs-actual variant, `actual_amount, variance_amount, variance_percent, is_favourable, is_unbudgeted`. |

---

## Part 4 — Work

**Phase 0 — Model truth (must land first; D3, D4)**
Migration: add `budget_code` (per-business unique, generated), `approved_by`,
`approved_at` (set by `set_budget_status` on draft→active), and make
`currency_code` honest — default it to the business base currency and reject a
value that differs, with a comment stating budgets are base-currency by
construction. Extend `get_budget_variance_report`'s companion metadata (a new
`get_budget_document_header(budget_id)` RPC) to return identity, scope, status,
approval, revision count and currency in one authoritative read.

**Phase 1 — Kill the second engine (D1)**
Delete `buildBudgetVsActual`'s hand-rolled logic; reimplement it as a thin call
to `get_budget_variance_report`, taking an explicit `budgetId` parameter
(falling back to the active budget for the requested period's fiscal year) and
carrying branch and period through. Add an architecture test asserting no
budget-vs-actual arithmetic exists outside SQL.

**Phase 2 — Budget Schedule dataset + column spec**
New `get_budget_schedule(budget_id)` RPC returning the account × period plan
with section and total flags, and a `budget_schedule` entry in
`_shared/reports/columnSpecs.ts`.

**Phase 3 — PDF**
Render both artifacts through the existing `render-report` PDF engine, reusing
masthead, typography, currency formatting and pagination, with a
budget-specific document model — the control block, the section/period grammar
above, and the quarter-fold rule. No reuse of invoice or trial-balance layout.

**Phase 4 — Excel + CSV** per the table above, in `_shared/exports/`.

**Phase 5 — Wire the UI**
Export buttons on `BudgetEditPage` (Budget Schedule) and the corrected
server-build config on `BudgetReport` (Budget vs Actual), reconciling the
`budget` / `budget_vs_actual` identifier drift (D5).

**Phase 6 — Verify against real data**
Seed a second budget: company-wide, 12 periods, both revenue and cost accounts,
one zero-plan line, one unbudgeted posted account, one applied revision — then
check the RPC, the screen, the PDF, the workbook and the CSV all agree, and that
a 200-account × 12-period PDF still paginates readably.

### Open question for you

Phase 0 changes the budget table. If you would rather I keep this strictly
read-only and produce the two artifacts against the model exactly as it stands,
the PDF simply omits budget code and approval identity, and prints "Revision N"
instead of a version. Say which you want before I start.
