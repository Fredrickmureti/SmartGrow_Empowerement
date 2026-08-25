# Projects Domain — Reconstruction Handoff

Authoritative execution file for the Projects module. Verified facts, verdicts, current wave, next wave. No essays.

## Current phase

Waves 1–2 verified by independent audit (see Verification verdict). **Wave 2 closeout + Wave 3 (Configuration, Currency, Templates, Stages) is next.**

## Verification verdict (this pass — evidence in the database and codebase)

Confirmed genuinely implemented, not claimed:
- RLS on `projects`, `project_tasks`, `project_stages`, `project_milestones`, `project_members`, `project_documents` now uses `project_can_read` / `project_can_write` / `project_can_delete` / `project_is_governor` symmetrically across SELECT/INSERT/UPDATE/DELETE. The Wave-0 read/write asymmetry is closed. `projects` INSERT additionally enforces `is_org_member` + `user_can_access_branch`.
- Command RPCs exist and are SECURITY DEFINER: `project_create`, `project_update_config`, `project_change_status`, `project_add_member`, `project_remove_member`, `project_archive`, `project_closure_blockers`, `project_log_activity`, `project_status_transition_allowed`, plus task commands `project_task_complete`, `project_task_reopen`, `project_task_move_stage`, `project_task_assign` over `_project_task_assert_writable`.
- `project_update_config` enforces a field allow-list, a governor-only set for commercial/authority fields (`pricing_type`, `currency`, `budget*`, rates, `manager_id`, `privacy`, `branch_id`, `customer_id`, `project_type`), branch authorization on `branch_id` moves, and makes `default_billable_rate` follow `hourly_rate` (single rate source).
- `src/hooks/projects/useProjects.ts` and `useProjectTasks.ts` route mutations through the RPCs; `updateTask` strips lifecycle fields and re-routes them. Guard test `src/__tests__/architecture.projects-server-authority.test.ts` exists and passes (2/2).

Defects found that the previous notes did not record:
1. **Regression — project settings save is broken.** `src/components/projects/ProjectSettings.tsx` still submits `status` through `updateProject` → `project_update_config`, which now rejects any field outside its allow-list (`Field status cannot be changed through project_update_config`). Status editing has no working path in the UI; `changeProjectStatus` has zero call sites.
2. **Optimistic concurrency is dead code.** `projects.version` and the `_expected_version` argument exist, but no call site passes a version, so conflicts are never detected in practice.
3. **Version-conflict (40001) and `project_closure_blockers` results are never surfaced** — they bubble as raw Postgres errors.
4. **Guard test is too narrow.** It bans direct writes to `projects` / `project_members` only; direct `project_tasks` writes to `is_done` / `stage_id` / `assigned_to` are still possible from any new file.
5. **Currency is still free text.** `src/components/projects/ProjectForm.tsx` hardcodes a 12-entry currency list and defaults to `USD`, ignoring `business_active_currencies` / `businesses.base_currency`.

## Canonical engines Projects must consume (unchanged, re-confirmed)

Currency/FX (`business_active_currencies`, `exchange_rates`, `resolve_exchange_rate`), analytic accounting (`trg_projects_sync_analytic_account`, `_default_analytic_from_project`), timesheets (`timesheets`, `timesheet_submissions`, `resolve_timesheet_billing_rate`), documents (`ensureDocumentRecord`), events (`business_event_outbox`), access (`has_role`, `is_org_member`, `user_has_module_permission`, `user_can_access_branch`).

Projects owns only: project identity + lifecycle, project billing *configuration*, membership/roles, stages, tasks, milestones, project-scoped read models.

## Wave 2 closeout (do first)

1. Rewire `ProjectSettings.tsx` to split its save: configuration fields → `updateProject`; `status` → `changeProjectStatus` with `expectedVersion` from the loaded row. Same for any other surface that edits status (portfolio kanban, detail header).
2. Load and thread `projects.version` through the project hooks so every status change sends `_expected_version`.
3. Error mapping helper: `40001` → "This project was changed by someone else — reload and retry"; closure-blocker exceptions → list the blockers returned by `project_closure_blockers` in the dialog before the close action is attempted.
4. Extend the architecture guard: ban direct `project_tasks` writes to `is_done` / `stage_id` / `assigned_to` / `completed_at`, and assert the four `project_task_*` RPCs are used.
5. Run the Projects test files plus a typecheck; record the result here.

## Wave 3 — Configuration, currency, templates, stages (next)

1. Currency: replace the hardcoded list in `ProjectForm.tsx` with the tenant's active currencies; default to the business base currency. Validate `projects.currency` server-side inside `project_create` / `project_update_config` against `business_active_currencies` for the owning business; migrate existing invalid values.
2. Money formatting: route the 5+ ad-hoc `Intl.NumberFormat` sites in Projects through the shared currency formatter.
3. Rate resolution: read `resolve_timesheet_billing_rate()` and document the precedence chain (task → member → project → employee); delete any client-side mirror that competes with it.
4. Configuration locking: once approved timesheets, cost/revenue entries or invoices exist on a project, block changes to `currency`, `pricing_type`, `is_billable` and `branch_id` inside `project_update_config`.
5. Templates: confirm `apply_project_template` is a one-time materialization (no live inheritance) and that template IDs are validated against the caller's business/branch scope; add the check if missing.
6. Stages: enforce stage-belongs-to-project (already in `project_task_move_stage` — verify), stage ordering and closed-stage semantics; validate stage configuration is per-business.

## Remaining waves (unchanged order)

- **Wave 4 — Workforce & timesheets.** Split membership into access vs. billable participation vs. project role; server-side eligibility and branch rules; all project time through canonical `timesheets`; workload reads canonical capacity.
- **Wave 5 — Commercial & financial.** Budget semantics, cost/revenue writers audited, analytic linkage end-to-end, invoicing hardened, profitability from canonical data.
- **Wave 6 — Milestones, documents, collaboration.** Milestones as billing/acceptance events; documents onto `ensureDocumentRecord`; register `projects.*` outbox topics; notifications on real events.
- **Wave 7 — Reporting & read models.** Identify/repair writers of `project_burndown_daily`, `project_member_workload_week`, `project_portfolio_kpis`.
- **Wave 8 — Scenario verification.** Internal project; billable T&M through to receivable; concurrent manager edits; closure with open work; cross-branch and cross-business denial tests.

## Open items / prerequisites

- Writers of `project_burndown_daily`, `project_member_workload_week`, `project_portfolio_kpis` still unidentified (Wave 7 blocker).
- Outbox topic-registration contract for `projects.*` events unconfirmed (Wave 6 blocker).
- `resolve_timesheet_billing_rate()` body still unread (Wave 3 item 3).
- Branch scoping in project reads is still partly client-side (`applyBranchFilter`); `project_can_read` must be audited for branch enforcement before Wave 7 reporting is trusted.
