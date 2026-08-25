# Projects Domain — Reconstruction Handoff

Authoritative execution file for the Projects module. Keep it short: verified facts, verdicts, current wave, next wave. No essays.

## Current phase

Wave 0 complete (investigation). Awaiting approval to start **Wave 1 — Authority & Access**.

## Verified facts (evidence-based, this pass)

Schema
- `public.projects` (41 cols) already carries the full commercial surface: `project_type`, `customer_id`, `pricing_type`, `currency`, `budget`, `budget_type`, `hourly_rate`, `default_billable_rate`, `allocated_hours`, `spent_hours`, `is_billable`, `allow_timesheets`, `privacy`, `manager_id`, `branch_id`, `template_id`, `is_template`, `source_lead_id`, `source_sales_order_id`, `analytic_account_id`.
- Supporting tables exist: `project_stages`, `project_members`, `project_tasks` (44 cols, full lifecycle fields incl. dependencies/blocking/recurrence), `task_comments`, `task_dependencies`, `task_followers`, `project_milestones`, `project_documents`, `project_updates`, `project_activity_log`, `project_cost_entries`, `project_revenue_entries`, `project_burndown_daily`, `project_member_workload_week`, `project_portfolio_kpis`, `project_templates`, `project_recurring_templates`.
- `timesheets` is canonical and already project-aware (`project_id`, `task_id`, `is_billable`, `billing_rate`, `billing_amount`, `cost_rate`, `invoice_id`, `payroll_period_id`, `payroll_locked`).

Canonical engines that already exist and must be consumed, not rebuilt
- Currency/FX: `businesses.base_currency` + `business_active_currencies` + `exchange_rates`, one rate book via `useTenantFx` / `resolveWorkspaceCurrency`; server posting rates via `resolve_exchange_rate` / `to_base_amount`. A guard test already forbids a second FX engine.
- Analytic accounting: one analytic account per project is auto-provisioned by trigger `trg_projects_sync_analytic_account`; `_default_analytic_from_project()` back-fills `analytic_account_id` on `bill_items`, `invoice_items`, `expenses` from `project_id`. Projects must never write analytic accounts.
- Timesheets: `timesheets` / `timesheet_submissions` / `timesheet_settings` + `src/hooks/timesheets/*`. Distinct from HR `attendance_*` (presence, not project time).
- Documents: `ensureDocumentRecord()` → `document_records` / `document_artifacts`; direct inserts blocked by an architecture guard.
- Events: DB triggers insert into `business_event_outbox`; client mirrors via `domainEventBus` / `BusinessSaga`. No `projects.*` topics exist yet.
- Access: `has_role`, `is_org_member`, `_assert_org_member`, `user_has_module_permission`, `can_access_project`, `user_is_project_member`; branch scoping today is client-side `applyBranchFilter`.

## Architectural verdicts

1. **Projects has no server authority.** There is no `createServerFn` layer anywhere; all project/stage/task/milestone/document/member writes are direct browser `.from(...)` calls from `src/hooks/projects/*`. Only invoicing is server-side (edge functions `invoice-project-milestone`, `invoice-project-timesheets`).
2. **Security defect (confirmed via `pg_policies`).** `projects_update_perm` / `projects_delete_perm` / `project_tasks_*_perm` check only `user_has_module_permission(... 'projects' ...)`. `projects_select_perm` additionally enforces privacy/membership — so a user who cannot *see* a private project can still *update or delete* it by ID. Same gap on tasks, stages, milestones. No branch scoping in any project RLS policy.
3. **Rate resolution is duplicated.** DB owns `resolve_timesheet_billing_rate()`, but the browser mirrors `hourly_rate` into `default_billable_rate` on insert, and three components read/write rate fields independently. One resolver must win.
4. **Currency is bypassed.** Project money is formatted with ad-hoc `Intl.NumberFormat` in 5+ files; project `currency` is a free text column with no FK/validation against `business_active_currencies`.
5. **Lifecycle is not a state machine.** `status`, stages, `is_done`, milestone completion and closure are free-form text updates from the browser: no transition validation, no version/optimistic concurrency, no closure guard on open tasks or unbilled time.
6. **Activity/audit is client-written** (`project_task_activities` inserted from the browser), so it is forgeable and incomplete.
7. **No `projects.*` business events** are emitted; workload/burndown/KPI tables are projections whose writers must be identified before reports are trusted.

Scope decision: Projects consumes Finance (currency, analytic, invoicing), Timesheets, Documents, and the event outbox. It owns only: project identity + lifecycle, project billing *configuration*, membership/roles, stages, tasks, milestones, and project-scoped read models.

## Wave plan (revised from the initial hypothesis)

Access authority moves to Wave 1 because every later wave depends on trustworthy writes.

- **Wave 1 — Authority & Access.** Close the RLS write/read asymmetry (membership + privacy + branch on write, not just read). Introduce server-side project command RPCs (`SECURITY DEFINER`, `_assert_org_member` + project-access assertions) for create/update/close/delete. Client hooks call RPCs instead of table writes. Add architecture guard tests forbidding direct `projects*` table writes from `src/`.
- **Wave 2 — Lifecycle & concurrency.** Explicit project + task state machines with server-validated transitions, row versioning/optimistic concurrency, DB-written activity/audit, closure guards (open tasks, unapproved timesheets, unbilled milestones).
- **Wave 3 — Configuration, currency, templates, stages.** Validate `currency` against `business_active_currencies`, single rate resolver (DB `resolve_timesheet_billing_rate` authoritative, drop the client mirror), lock config fields once work exists, confirm template instantiation is a one-time materialization (`apply_project_template`) with no live inheritance.
- **Wave 4 — Workforce & timesheets.** Split project membership into access vs. billable participation vs. project role; enforce eligibility server-side; ensure all project time flows only through canonical `timesheets`; workload reads canonical capacity.
- **Wave 5 — Commercial & financial.** Budget semantics made real (which spend consumes it), cost/revenue entry writers audited, analytic linkage verified end-to-end, invoicing path hardened, profitability derived from canonical data.
- **Wave 6 — Milestones, documents, collaboration.** Milestones as billing/acceptance events; documents migrated onto `ensureDocumentRecord`; `projects.*` topics registered in the outbox with notifications tied to real events.
- **Wave 7 — Reporting & read models.** Identify/repair writers of `project_burndown_daily`, `project_member_workload_week`, `project_portfolio_kpis`; reports read canonical data or justified projections.
- **Wave 8 — Scenario verification.** Internal project, billable T&M project through to receivable, concurrent manager edits, closure with open work.

Each wave ends only after the UI → authorization → command → validation → transaction → event → consumer → read model path is traced and tested end-to-end.

## Wave 1 — exact scope (next)

1. Migration: rewrite RLS on `projects`, `project_tasks`, `project_stages`, `project_milestones`, `project_members`, `project_documents` so INSERT/UPDATE/DELETE require the same visibility predicate as SELECT (org permission AND admin/manager/member/privacy) plus branch access; add helper `project_can_write(project_id, user_id)`.
2. Migration: `SECURITY DEFINER` command functions — `project_create`, `project_update_config`, `project_change_status`, `project_add_member`, `project_remove_member`, `project_archive` — each asserting org membership, project write access, and field-level authority (only manager/admin may change billing config, manager, privacy, branch).
3. Refactor `src/hooks/projects/useProjects.ts` (and the member/stage paths) to call those RPCs; remove client-side project-number, default-stage and member-insert sequencing.
4. Add `src/__tests__/architecture.projects-server-authority.test.ts` guard.
5. Verify: attempt update of a private project as a non-member with module write permission — must fail server-side.

## Failed tests / open items

- Writers of `project_burndown_daily`, `project_member_workload_week`, `project_portfolio_kpis` not yet identified (Wave 7 prerequisite).
- Outbox topic-registration contract for new `projects.*` events not yet confirmed (Wave 6 prerequisite).
- `resolve_timesheet_billing_rate()` body not yet read; must confirm the full precedence chain (task → member → project → employee) before Wave 3.
