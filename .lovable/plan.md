# Projects Domain — Reconstruction (authoritative status)

Single source of truth for the Projects module rebuild. Verified facts only.
Predecessor record: `.lovable/plan/projects-domain-reconstruction-handoff-2026-08-25.md`.

## Where we are

- **Waves 1–2: complete and verified.**
- **Wave 3 (Configuration, Currency, Rates, Templates, Stages): complete this pass.**
- **Active next: Wave 4 — Workforce & timesheets.**

## Wave 1 — Authority & access (DONE, verified)

- RLS on `projects`, `project_tasks`, `project_stages`, `project_milestones`,
  `project_members`, `project_documents` is symmetric across SELECT/INSERT/
  UPDATE/DELETE via `project_can_read` / `project_can_write` /
  `project_can_delete` / `project_is_governor`. `projects` INSERT also enforces
  `is_org_member` + `user_can_access_branch`.
- Command RPCs (SECURITY DEFINER): `project_create`, `project_update_config`,
  `project_change_status`, `project_add_member`, `project_remove_member`,
  `project_archive`, `project_closure_blockers`, `project_log_activity`,
  `project_status_transition_allowed`, and task commands
  `project_task_complete` / `_reopen` / `_move_stage` / `_assign`.

## Wave 2 — Lifecycle & concurrency (DONE, verified)

- `useProjects.updateProject` splits the payload: configuration fields →
  `project_update_config`; `status` → `project_change_status`.
- `ProjectSettings.tsx` sends `status` **only on a real transition**, runs
  `project_closure_blockers` before completing/cancelling, and passes
  `project.version` for optimistic concurrency.
- `src/lib/projects/commandErrors.ts` maps `40001` (concurrent edit), `42501`
  (not permitted) and `P0002` (not found) to human messages; every project
  command hook routes failures through it.
- Guard test `src/__tests__/architecture.projects-server-authority.test.ts`
  bans direct writes to `projects` / `project_members` and to the
  `project_tasks` lifecycle columns (`is_done`, `stage_id`, `assigned_to`,
  `completed_at`). **6/6 passing.**

## Wave 3 — Configuration, currency, rates, templates, stages (DONE this pass)

1. **Currency** — `ProjectForm.tsx` reads the tenant's active currencies via
   `useBusinessCurrencies` (`list_business_active_currencies`) and defaults to
   the business base currency; the hardcoded 12-entry list is gone.
   `_project_assert_currency` validates `projects.currency` inside
   `project_create` and `project_update_config`.
2. **Money formatting** — every Projects money site now uses the shared
   formatter (`formatCurrency` / `formatCompactNumber` in `src/lib/utils.ts`):
   `ProjectFinancials`, `ProjectOverview`, `projects/detail/Sales`,
   `projects/detail/Purchases`, `projects/portfolio/Portfolio`. No
   `Intl.NumberFormat` remains under `src/components/projects` or
   `src/pages/projects`.
3. **One billing-rate engine** — new
   `public.resolve_project_billing_rate(project, employee, explicit)` owns the
   precedence chain: explicit entry rate → `project_members.billable_rate` for
   that employee → `projects.default_billable_rate` (legacy fallback
   `hourly_rate`). `trg_timesheets_billing` and
   `resolve_timesheet_billing_rate` both delegate to it — the previous
   disagreement (trigger used `projects.hourly_rate`, resolver used the member
   rate) is closed. `project_billing_rate_preview(project, employee)` is the
   authorized read for the UI (`project_can_read`, `authenticated` only);
   `useProjectBillingRate` consumes it and `TimesheetEntryForm` no longer
   mirrors any rate logic. Guarded by a new architecture test.
4. **Configuration locking** — once a project has recorded time or reached
   milestones (`_project_has_financial_activity`), `project_update_config`
   refuses to change `currency`, `pricing_type`, `is_billable` **and
   `branch_id`**; no-op resubmits of the same value still pass.
5. **Templates** — `apply_project_template` is a one-time materialization;
   template ownership is validated against the caller's business and write
   permission (hardened in the Wave 3 first pass).
6. **Stages** — `project_task_move_stage` already enforces
   stage-belongs-to-project. Added `project_stage_biu` (auto sequence
   `max+10` on insert, name required and trimmed, a stage can never be moved to
   another project) and `project_stage_bd` (a stage holding tasks cannot be
   deleted), plus a unique index on `(project_id, lower(name))`.

**Verification run this pass:** `tsgo --noEmit` clean;
`architecture.projects-server-authority.test.ts` 6/6 green;
`src/test/timesheets` green. Four failures elsewhere in `src/__tests__`
(receiving scanner presence, Dialog import ban, KRA/eTIMS reference ban,
`authority_contact_id`) are **pre-existing and outside Projects** — untouched
by this wave.

## Wave 4 — Workforce & timesheets (NEXT — start here)

1. Split `project_members` semantics: access (who may read/write), billable
   participation (who may book time and at what rate), and project role
   (manager / lead / member). Today one row carries all three.
2. Server-side eligibility: `project_add_member` must enforce the branch and
   business rules for the invited user; booking time on a project must require
   membership (or an explicit "open to org" setting), enforced in the database
   rather than by the form.
3. All project time flows through canonical `timesheets` /
   `timesheet_submissions` — audit any project-local time writer and delete it.
4. Workload reads canonical capacity, not a project-local assumption
   (`project_member_workload_week` writer is still unidentified — see blockers).

## Remaining waves (order unchanged)

- **Wave 5 — Commercial & financial.** Budget semantics, cost/revenue writers,
  analytic linkage end-to-end, invoicing, profitability from canonical data.
- **Wave 6 — Milestones, documents, collaboration.** Milestones as billing/
  acceptance events; documents onto `ensureDocumentRecord`; register
  `projects.*` outbox topics; notifications on real events.
- **Wave 7 — Reporting & read models.** Identify/repair writers of
  `project_burndown_daily`, `project_member_workload_week`,
  `project_portfolio_kpis`.
- **Wave 8 — Scenario verification.** Internal project; billable T&M to
  receivable; concurrent manager edits; closure with open work; cross-branch
  and cross-business denial tests.

## Open blockers carried forward

- Writers of `project_burndown_daily`, `project_member_workload_week`,
  `project_portfolio_kpis` unidentified (Wave 7 blocker; Wave 4 item 4 partly
  depends on it).
- Outbox topic-registration contract for `projects.*` unconfirmed (Wave 6).
- Branch scoping in project reads is still partly client-side
  (`applyBranchFilter`); `project_can_read` must be audited for branch
  enforcement before Wave 7 reporting is trusted.

## Instructions for the next agent

1. **Verify before you build.** Confirm, against the live database and the
   codebase — not against this file — that Wave 3 is genuinely done:
   - `resolve_project_billing_rate` exists and both `trg_timesheets_billing`
     and `resolve_timesheet_billing_rate` delegate to it (read the function
     bodies).
   - `project_update_config` locks `branch_id` alongside currency /
     pricing_type / is_billable when `_project_has_financial_activity` is true.
   - Triggers `project_stage_biu` / `project_stage_bd` are attached to
     `project_stages`.
   - `rg -n "Intl.NumberFormat" src/components/projects src/pages/projects`
     returns nothing.
   - `bunx vitest run src/__tests__/architecture.projects-server-authority.test.ts`
     is 6/6 and `npx tsgo --noEmit` is clean.
   Record the verdict at the top of this file.
2. **Then resume at Wave 4 item 1** — not at unrelated work, and not at a later
   wave. Bring Wave 4 to a coherent, production-ready state (schema + RPCs +
   UI + guard test + tests green) before opening Wave 5.
3. **Update this file immediately after each item lands**, moving it from the
   Wave 4 list into a DONE section with the evidence that proves it.
