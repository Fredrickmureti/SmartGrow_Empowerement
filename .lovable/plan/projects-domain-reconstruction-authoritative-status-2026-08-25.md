# Projects Domain — Reconstruction (authoritative status)

Single source of truth for the Projects module rebuild. Verified facts only.
Predecessor record: `.lovable/plan/projects-domain-reconstruction-handoff-2026-08-25.md`.

## Handover verification verdict — 2026-08-25 (independent, this pass)

Every Wave 3 claim was re-checked against the live database and the codebase.
**Verdict: Wave 3 is genuinely complete. No rework required.**

| Claim | Evidence |
|---|---|
| One billing-rate engine | `resolve_project_billing_rate(project, employee, explicit)` exists; `resolve_timesheet_billing_rate` and the `timesheets_billing` trigger function `trg_timesheets_billing` **both** delegate to it (function bodies read, not inferred). `project_billing_rate_preview` exists as the authorized UI read. |
| Config lock includes `branch_id` | `project_update_config` locks `currency`, `pricing_type`, `is_billable`, `branch_id` behind `_project_has_financial_activity`, with no-op resubmits allowed. |
| Currency validated server-side | `_project_assert_currency(org, business, code)` called on every `currency` patch. |
| Stage guards attached | Triggers `project_stage_biu` → `_project_stage_biu` and `project_stage_bd` → `_project_stage_bd` are live on `project_stages`; unique index `project_stages_project_name_uk` present. |
| Money formatting centralised | `rg "Intl.NumberFormat" src/components/projects src/pages/projects` → no matches. |
| Tests / typecheck | `architecture.projects-server-authority.test.ts` **6/6 green**; `tsgo --noEmit` **clean**. |

Waves 1–2 remain as previously verified. **Wave 4 server-side authority is landed and live-verified (2026-08-25); resume at Wave 4.4 (one timesheet writer) / 4.5 (canonical workload).**

### Wave 4 verification log (2026-08-25)

- **4.1 membership semantics** — `project_members.project_role`, `can_write`,
  `is_billable_participant` added with backfill; `projects.allows_cross_branch_work`,
  `projects.time_entry_open_to_org` added and governed via `project_update_config`.
- **4.2 member add path** — `project_add_member` rebuilt as a 6-arg SECURITY DEFINER
  RPC: governor-only, org membership, active in-business employee, branch eligibility
  with `allows_cross_branch_work` escape, role normalization, derived `can_write`.
  Old 4-arg overload dropped; EXECUTE revoked from PUBLIC/anon.
- **4.3 timesheet eligibility trigger** — `_timesheet_assert_project_eligibility` +
  `trg_timesheets_project_eligibility` (BEFORE INSERT/UPDATE, ahead of
  `timesheets_billing`): same-business check, closed/disabled project rejection,
  branch pinning, membership-or-open-to-org gate. **Live SQL scenario test
  `supabase/tests/projects_wave4_timesheet_authority_test.sql` passed end-to-end**
  (governor add, cross-branch refusal/allowance, non-governor refusal, member booking,
  wrong-branch refusal, open-to-company booking, completed-project refusal,
  non-billable → rate 0, billable → member rate).
- **Incidental defect fixed:** `project_employee_cost_rate` referenced
  `employees.basic_salary`, a column that does not exist — every project-linked
  timesheet save failed in production (`42703`). Function dropped/recreated with
  precedence employee `cost_rate_override` → project `hourly_rate` → 0, labor-burden
  multiplier preserved; EXECUTE tightened.
- Remaining Wave 4 items: **4.4** (single canonical timesheet writer sweep),
  **4.5** (workload from canonical capacity; drop mirrored `project_members.role`),
  **4.6** (extend the architecture guard test to ban direct `project_members` writes).

### New defects found during this verification (added to Wave 4 scope)

1. **Booking time against a project is unauthorized at the database layer.**
   `timesheets` INSERT/UPDATE policies check only the *employee* identity and
   the timesheets module permission — nothing validates that `project_id`
   belongs to the caller's business, that the employee's branch may work on
   that project, or that the employee is a project member. Any authenticated
   employee can post hours (and, on a billable project, revenue) against **any
   project id they can guess**. `trg_timesheets_billing` checks only that the
   project is billable.
2. **`project_add_member` performs no branch eligibility check.** It validates
   `is_org_member(_user_id, organization_id)` only — a user from another branch
   can be added to a branch-scoped project with no explicit cross-branch
   decision.
3. **`project_members` collapses three distinct concepts into one row**
   (`role`, `billable_rate`): access, billable participation, and project role
   are indistinguishable, which is why (1) has no rule to enforce.

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
- `ProjectSettings.tsx` sends `status` only on a real transition, runs
  `project_closure_blockers` before completing/cancelling, and passes
  `project.version` for optimistic concurrency.
- `src/lib/projects/commandErrors.ts` maps `40001` / `42501` / `P0002` to human
  messages; every project command hook routes failures through it.
- Guard test `architecture.projects-server-authority.test.ts` bans direct writes
  to `projects` / `project_members` and to the `project_tasks` lifecycle
  columns. 6/6 passing.

## Wave 3 — Configuration, currency, rates, templates, stages (DONE, verified)

1. Currency from `useBusinessCurrencies` (`list_business_active_currencies`),
   server-validated by `_project_assert_currency`.
2. All Projects money sites use the shared `formatCurrency` /
   `formatCompactNumber`.
3. One billing-rate engine: `resolve_project_billing_rate` (explicit → member
   rate → project default), consumed by the timesheets trigger, the timesheet
   resolver and `useProjectBillingRate` via `project_billing_rate_preview`.
4. Configuration locking on financial activity, incl. `branch_id`.
5. `apply_project_template` is a one-time materialization with business +
   write-permission validation.
6. Stage integrity triggers and the per-project unique stage name index.

## Wave 4 — Workforce & timesheets (ACTIVE — execute in this order)

**4.1 Split `project_members` semantics.** Add `access` (read/write member),
`is_billable_participant`, and a constrained `project_role`
(`manager` | `lead` | `member`) with `billable_rate` meaningful only for
billable participants. Backfill existing rows from `role`. Keep `role` in place
for one wave, mirrored by trigger, then drop it in 4.5.

**4.2 Server-side membership eligibility.** Extend `project_add_member` to
validate, in addition to `is_org_member`: the invitee resolves to an active
employee in the project's business; the employee's branch is either the
project's branch or the project is explicitly marked cross-branch; the caller
is authorized for that branch (`user_can_access_branch`). Raise `42501` with a
specific message per failure. Add `projects.allows_cross_branch_work boolean
not null default false`, governor-settable through `project_update_config`.

**4.3 Close the time-booking hole (highest severity).** Add
`_timesheet_assert_project_eligibility(project_id, employee_id)` and call it
from a `BEFORE INSERT OR UPDATE` trigger on `timesheets` (before
`trg_timesheets_billing`). It must assert: project exists and is in the
employee's business; project status accepts time (not `completed`/`cancelled`/
archived); employee branch matches the project branch or
`allows_cross_branch_work`; the employee is a project member — or the project
carries an explicit `time_entry_open_to_org` flag. No client change may relax
this.

**4.4 One timesheet writer.** Audit every project-local time writer
(`src/hooks/projects/*`, `src/pages/projects/detail/Timesheets.tsx`, POS/HR
paths that touch project hours). Anything writing hours outside canonical
`timesheets` / `timesheet_submissions` is deleted, not kept as a fallback.

**4.5 Workload from canonical capacity.** Identify the writer of
`project_member_workload_week` (currently unknown — read-only consumers in
`Workload.tsx`). Until it is identified, `Workload.tsx` must read canonical
timesheet hours + HR capacity directly rather than an unwritten projection.
Drop the mirrored `project_members.role` here.

**4.6 Guard test + verification.** Extend
`architecture.projects-server-authority.test.ts` to ban direct
`project_members` column writes and any non-canonical hours writer; add a DB
scenario test proving cross-branch and non-member time booking is rejected.
`tsgo --noEmit` clean and the Projects/timesheets suites green before Wave 5
opens.

## Remaining waves (order unchanged)

- **Wave 5 — Commercial & financial.** Budget semantics, cost/revenue writers,
  analytic linkage end-to-end, invoicing, profitability from canonical data.
- **Wave 6 — Milestones, documents, collaboration.** Milestones as billing/
  acceptance events; documents onto `ensureDocumentRecord`; register
  `projects.*` outbox topics; notifications on real events.
- **Wave 7 — Reporting & read models.** Writers of `project_burndown_daily`,
  `project_member_workload_week`, `project_portfolio_kpis`.
- **Wave 8 — Scenario verification.** Internal project; billable T&M to
  receivable; concurrent manager edits; closure with open work; cross-branch
  and cross-business denial tests.

## Open blockers carried forward

- Writers of `project_burndown_daily`, `project_member_workload_week`,
  `project_portfolio_kpis` unidentified (Wave 7; Wave 4.5 depends on it).
- Outbox topic-registration contract for `projects.*` unconfirmed (Wave 6).
- Branch scoping in project reads is still partly client-side
  (`applyBranchFilter`); `project_can_read` must be audited for branch
  enforcement before Wave 7 reporting is trusted.

## Working rules

- One migration per object, single-purpose — never batched.
- Update this file immediately after each numbered item lands, with the
  evidence that proves it.
