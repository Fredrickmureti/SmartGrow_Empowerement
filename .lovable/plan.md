# Projects Domain — Reconstruction (live authoritative status)

Live status for the Projects module rebuild. Verified facts only.
Historical records: `.lovable/plan/projects-domain-reconstruction-authoritative-status-2026-08-25.md`
and `.lovable/plan/projects-domain-reconstruction-handoff-2026-08-25.md`.

Backend: the Supabase project is already connected to this app (project ref
`jkszmrroyjfdwokbkzis`); no reconnection work is needed.

## Where the work stands

| Wave | Scope | State |
|---|---|---|
| 1–2 | Domain model, read paths, permissions | Complete (verified in archived record) |
| 3 | One billing-rate engine, config lock, currency validation, stage guards | Complete, re-verified |
| 4 | Workforce & timesheets (4.1–4.6) | Complete, guard test 8/8 green |
| 5 | Commercial & financial integration | ACTIVE — 5.1/5.2/5.3 verified, 5.4–5.5 open |
| 6 | Milestones, documents, collaboration, outbox topics | Pending |
| 7 | Reporting & read models (burndown, workload, portfolio KPIs writers) | Pending |
| 8 | End-to-end business-event simulation | Pending |

## Verification performed this session (read from the live database)

- **5.1e is applied.** `trg_je_line_to_project_ledger` no longer inserts into
  `project_cost_entries` directly; it calls `upsert_project_cost` /
  `upsert_project_revenue`. The previous engineer's "outcome unknown" flag is cleared.
- **5.1c/5.1d writers are in place.** Both upsert writers stamp `entry_nature`,
  `amount_base`, `fx_rate`, `base_currency`.
- **5.2 is done, contrary to the handoff note.** `compute_project_profitability(uuid, uuid)`
  sums `amount_base` filtered to `entry_nature='actual'`, reports committed cost and
  forecast revenue separately, and counts rows with `amount_base IS NULL` so the UI can
  show "unconverted" instead of a wrong margin. The 1-arg overload delegates to it.
- **5.3 landed.** `useProjectFinancials.ts` and `ProjectFinancials.tsx` consume the new
  RPC shape.
- **Still open:** `supabase/tests/projects_wave5_ledger_integrity_test.sql` does not
  exist, and `ProjectFinancials.tsx` still reads the scalar `projects.budget`
  (defect D4).

## Remaining work, in execution order

### 5.4 Ledger integrity SQL test
New `supabase/tests/projects_wave5_ledger_integrity_test.sql` asserting: a PO plus the
bill for the same goods produces one actual cost (PO stays a commitment); a sales order
plus its invoice produces one actual revenue; a bill tagged to two projects saves two
ledger rows (D3 grain); a foreign-currency document with no resolvable rate leaves
`amount_base` NULL and raises the unconverted flag rather than fabricating a 1.0 rate.

### 5.5 Budget semantics (D4)
Stop reading `projects.budget` for budget-vs-actual. Read the canonical budgets domain
(`budgets` / `budget_items` scoped to the project's analytic account) through a single
server-side read, compare against actual cost in base currency, and surface budget
consumption from that. Keep the scalar only as an informational input if the domain has
no budget row; never as a competing source of truth.

### 5.6 Analytic linkage audit
Confirm project → analytic account on every posting path (timesheet, expense, bill,
invoice, milestone) using `project_analytic_reconciliation`; fix any path that posts
without the project's analytic account.

### Wave 6 — Milestones, documents, collaboration
Milestone approval as a real business event (billing/acceptance effects), project
documents through the canonical document engine with tenant/business/branch and
membership checks on download, project activity/comments, and registration of the
`projects.*` outbox topics with authorization-preserving consumers.

### Wave 7 — Reporting & read models
Identify or implement the writers for `project_burndown_daily` and
`project_portfolio_kpis`; move branch scoping out of the client (`applyBranchFilter`)
into `project_can_read` / server reads, and verify no report, count, chart, or export
aggregates outside the caller's authorized branch/business scope.

### Wave 8 — End-to-end business-event simulation (explicitly requested)
Drive the full lifecycle against the live app with a seeded tenant, fixing every bug hit
along the way rather than working around it:

```text
CRM lead won  →  project created (tenant/business/branch ownership stamped)
  →  commercial config (billable, pricing model, currency via Finance)
  →  manager assigned, team members added within authorized branch scope
  →  stages/tasks from template  →  tasks assigned
  →  employees log timesheets (canonical writer, server-owned rates)
  →  expenses + a vendor bill tagged to the project
  →  milestone completed and approved
  →  invoice generated from timesheets and milestone  →  receivable
  →  profitability: actual vs committed, base currency, budget consumption
  →  closure with open-work validation  →  historical reporting intact
```
Plus negative security passes in the same run: Branch A user denied on a Branch B
project/task/timesheet by forged ID, cross-business search and export denied,
non-Finance user denied financial fields.

## Working rules

- One migration per object, single-purpose — never batched.
- Update this file immediately after each numbered item lands, with the evidence.
- No fallbacks left behind: a replaced writer is deleted, not kept beside the new one.
- Supabase linter baseline is 3682 pre-existing findings; compare against that number,
  do not treat it as new debt.

## Technical notes

- Profitability contract: `compute_project_profitability(project_id, business_id)`
  returns actual cost/revenue in base currency, committed cost, forecast revenue,
  per-source breakdowns, hours, and unconverted-row counts.
- Ledger grain: `(source_type, source_id, project_id, coalesce(task_id, zero-uuid))` on
  cost, `(…, coalesce(milestone_id, zero-uuid))` on revenue.
- FX only through `resolve_exchange_rate(org, business, currency, date)`, which returns
  NULL when no rate exists.
