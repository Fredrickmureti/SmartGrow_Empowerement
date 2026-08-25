# Projects Domain — Reconstruction (live authoritative status)

This file is the live status for the Projects module rebuild. Verified facts only.
Historical records: `.lovable/plan/projects-domain-reconstruction-authoritative-status-2026-08-25.md`
and `.lovable/plan/projects-domain-reconstruction-handoff-2026-08-25.md`.

## Where the work stands

| Wave | Scope | State |
|---|---|---|
| 1–2 | Domain model, read paths, permissions | Complete (verified in the archived record) |
| 3 | One billing-rate engine, config lock, currency validation, stage guards | Complete and independently re-verified 2026-08-25 |
| 4 | Workforce & timesheets (4.1–4.6) | **Complete 2026-08-25** |
| 5 | Commercial & financial integration | **ACTIVE — this is the current phase** |
| 6 | Milestones, documents, collaboration, outbox topics | Pending |
| 7 | Reporting & read models (burndown, workload, portfolio KPIs writers) | Pending |
| 8 | Scenario verification (end-to-end business simulations) | Pending |

### Wave 4 closure evidence (2026-08-25)

- 4.1–4.3 server-side authority: membership semantics, 6-arg `project_add_member`,
  `_timesheet_assert_project_eligibility` trigger. Live SQL scenario test
  `supabase/tests/projects_wave4_timesheet_authority_test.sql` passed end-to-end.
- 4.4 one canonical timesheet writer: `src/lib/timesheets/timesheetWriter.ts` is the
  only client module that mutates `timesheets`. It stamps `organization_id` /
  `business_id`, sends `billing_rate` / `billing_amount` as null (server trigger owns
  them), derives `is_billable` from `projects.is_billable`, and owns
  `resolveMyEmployeeId`. Consumers refactored: `useTimesheets`,
  `components/projects/ProjectTimesheets.tsx`, `components/projects/TaskDetail.tsx`.
  Two live defects fixed by the consolidation: project time-logging screens inserted
  rows **without `business_id`**, and **hardcoded `is_billable: false`** on billable
  projects.
- 4.5 workload from canonical capacity: `project_member_workload_week` derives weekly
  capacity from `work_schedules`; `project_members.role` dropped.
- 4.6 guard test: suite "architecture: single canonical timesheet writer" in
  `src/__tests__/architecture.projects-server-authority.test.ts` fails the build on any
  `timesheets` write outside the writer. **8/8 green, `tsgo --noEmit` clean.**

## Wave 5 — Commercial & financial integration (ACTIVE)

### Audit findings, 2026-08-25 (read from the live database, not inferred)

The feeder plumbing exists and every trigger is attached and enabled
(`timesheets`, `expenses`, `bills`, `purchase_orders`, `invoices`, `sales_orders`,
`project_milestones`, `stock_movements`, `journal_entry_lines` →
`project_cost_entries` / `project_revenue_entries`, all through
`upsert_project_cost` / `upsert_project_revenue`). `trg_je_line_to_project_ledger`
correctly restricts itself to manual/unsourced journal entries, so document-driven
JEs are not double-mirrored. Both ledger tables are currently **empty (0 rows)**, so
these are forward-correctness defects with no historical data to repair.

Four defects block Wave 5 from being trusted:

- **D1 — commitments are counted as actuals.** `purchase_order` cost rows and
  `sales_order` revenue rows are commitments/forecast, but
  `compute_project_profitability` sums every row into `cost_total` / `revenue_total`.
  A confirmed PO that is later billed is counted twice (`purchase_order` +
  `vendor_bill`); a `fulfilled` sales order that is invoiced is counted twice
  (`sales_order` + `invoice`). Margin and margin % are wrong on any project that uses
  procurement or order-to-invoice flows.
- **D2 — mixed currencies are added together.** Each entry stores the source
  document's own `currency`, and the RPC sums `amount` across currencies while
  labelling the result the project currency. There is a canonical
  `resolve_exchange_rate(org, business, currency, date)` that returns NULL rather than
  inventing a rate; nothing in the project ledger uses it.
- **D3 — a multi-project source document cannot be saved.** The unique index
  `uq_project_cost_source (source_type, source_id)` allows only one ledger row per
  source document, yet the line-tagged branches of the bill / PO / invoice / sales
  order triggers insert one row per project (and per task). A vendor bill whose lines
  are tagged to two projects raises a unique violation and the bill save fails.
  Same on the revenue side.
- **D4 — budget comes from the `projects.budget` scalar** and `budget_used_pct` is
  computed from the mixed-currency cost total, bypassing the budgets domain.

### Wave 5 execution order

- **5.1 Ledger integrity (actual vs commitment, FX, grain).** IN PROGRESS.
  Add `entry_nature` ('actual' | 'commitment'), `amount_base`, `fx_rate`,
  `base_currency` to both ledger tables; regrain uniqueness to
  (source_type, source_id, project_id, task_id/milestone_id); stamp FX through
  `resolve_exchange_rate` inside the two upsert writers; classify PO/SO feeds as
  commitments; rewrite `compute_project_profitability` to report actuals in base
  currency with commitments and unconvertible rows surfaced separately; update
  `useProjectFinancials` + `ProjectFinancials.tsx`; extend the architecture guard test.
- **5.2 Budget semantics.** Replace the `projects.budget` scalar reading with the
  canonical budgets domain (`budgets` / `budget_items` scoped to the project's
  analytic account), keep a single budget-vs-actual read.
- **5.3 Invoicing round-trip.** Verify `invoice-project-timesheets` and
  `invoice-project-milestone` stamp `project_id` on lines, mark source rows invoiced,
  and cannot double-bill; confirm the revenue trigger picks them up exactly once.
- **5.4 Analytic linkage end-to-end.** Project → analytic account on every posting
  path (timesheet, bill, invoice, milestone), audited against
  `project_analytic_reconciliation`.
- **5.5 Wave 5 verification.** DB scenario test for a full commercial round trip;
  guard tests green; `tsgo --noEmit` clean before Wave 6 opens.

## Open blockers carried forward

- Writers of `project_burndown_daily` and `project_portfolio_kpis` unidentified (Wave 7).
- Outbox topic-registration contract for `projects.*` unconfirmed (Wave 6).
- Branch scoping in project reads is still partly client-side (`applyBranchFilter`);
  `project_can_read` must be audited for branch enforcement before Wave 7.

## Working rules

- One migration per object, single-purpose — never batched.
- Update this file immediately after each numbered item lands, with the evidence.
- No fallbacks left behind: a replaced writer is deleted, not kept beside the new one.

## Instructions for the next agent

1. Verify 5.1 before writing anything new: `entry_nature` / `amount_base` / `fx_rate`
   exist on both ledger tables; the old `uq_project_cost_source` and
   `uq_project_revenue_source` indexes are gone and replaced at project grain;
   `upsert_project_cost` / `upsert_project_revenue` resolve FX through
   `resolve_exchange_rate` and never default a rate to 1 for a foreign currency;
   `compute_project_profitability` separates actual from committed and reports
   unconverted rows; the Financials screen shows those numbers distinctly.
2. Then resume at **5.2 (budget semantics)**, followed by 5.3, 5.4, 5.5 — in that
   order. Do not start Wave 6 until 5.5 is green.
