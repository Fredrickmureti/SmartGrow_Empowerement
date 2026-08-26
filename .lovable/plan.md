# Timesheets — Architecture Re-Audit and Controlled Migration (Live Status)

Authoritative status for the Timesheets domain boundary work. Original scope and
domain verdict: `.lovable/plan/timesheets-architecture-re-audit-and-controlled-migration-2026-08-26.md`.

Last updated: 2026-08-26. Active phase: **Wave 5 (cleanup and verification) — in progress**.

## Domain rule (unchanged, governs all further work)

Governance decides *who may act*. Timesheets decides *what state the time record is in*.
Downstream domains (Payroll, Projects, Sales, Finance, Notifications) decide what
approved time *means*. One authority per responsibility; Timesheets owns no downstream effect.

## Wave 1 — Governance boundary — DONE, verified

- `guard_timesheet_self_approval` now resolves and passes the real `organization_id`
  (verified: function body references `organization_id`, no `p_org => NULL` path remains).
  Org governance mode, `self_action_policy('timesheet.approve')` and time-boxed
  overrides now actually govern timesheet approval.
- `_timesheet_can_approve` is competence-only (admin / hr_admin / direct manager /
  project manager). The self-action verdict comes solely from Governance.
- `timesheet_settings.allow_self_approval` dropped (verified: column absent), and
  no timesheet RPC references it (verified). Settings screen now states that
  Governance owns the policy.
- Business-scoped settings resolution used by the approval RPC.

## Wave 2 — Server-authoritative approval capability — DONE, verified

- `governance_self_action_verdict(actor, subject, action, org, entity_id)` — read-only
  projection of the Governance decision (`not_self` / `allow` / `warn` /
  `override_available` / `block`). Mirrors enforcement exactly, including
  entity-scoped overrides, and mutates nothing.
- `timesheet_approval_capability(submission_id)` returns `can_approve`,
  `requires_override`, `reason`. Execute revoked from `anon`; granted to
  `authenticated` and `service_role`.
- Client consumes it: `useTimesheetApprovalCapability`, `TimesheetApprovals`,
  `TimesheetApprovalList` (governance badges, disabled approve/reject, reason surfaced).
  No client-side self-approval rule remains anywhere under `src/**/timesheets` (verified by search).

## Wave 3 — Event boundary reconnected — DONE, verified

Every `timesheet.*` topic now has an explicit resolution — push subscriber or a
recorded pull-consumption decision. No topic is left as an orphaned producer.

| Topic | Resolution |
| --- | --- |
| `timesheet.approved` | push → Projects spent-hours recompute, Payroll run flag |
| `timesheet.rejected` | push → Projects spent-hours recompute, Payroll run flag |
| `timesheet.corrected` | push → Projects entry recompute, Payroll entry flag |
| `timesheet.locked` | push → Payroll entry flag |
| `timesheet.unlocked` | push → Projects entry recompute, Payroll entry flag |
| `timesheet.submitted` | pull by design — notification delivered by `trg_timesheet_submission_notify`; reporting reads the outbox (recorded in the topic description) |
| `timesheet.billable_ready` | pull by design — Sales chooses when to bill; Finance/reporting read the outbox (recorded in the topic description) |

- Handlers live in the consuming domain: `projects_recompute_spent_hours_for_submission`,
  `projects_recompute_spent_hours_for_timesheet`, `payroll_flag_runs_for_timesheet_submission`,
  `payroll_flag_runs_for_timesheet`. Draft/pending runs are flagged; finalized runs are
  never mutated — they get a `payroll.timesheet.affects_finalized_run` audit entry.
- `tg_business_event_outbox_react_timesheet` dispatches both submission-scoped and
  timesheet-scoped events, gated on active subscription rows, and never breaks the
  outbox writer (events stay durably enqueued on handler failure).
- Entry-level handlers are `service_role`-only (revoked from `anon`/`authenticated`).

## Wave 4 — Invoice engine removed from Timesheets — DONE, verified

- `sales_invoice_project_timesheets` (Sales domain) now creates the invoice.
- `timesheets_mark_invoiced` is the only writer of the timesheet `is_invoiced` state,
  called by Billing.
- Legacy `invoice_project_timesheets` is a thin wrapper over the Sales function
  (verified: no direct `INSERT ... INTO public.invoices` remains in it), so existing
  callers `BillFromTimesheetsDialog.tsx` and `BillTimesheetsButton.tsx` keep working.

## Wave 5 — Cleanup and verification — ACTIVE, partially done

Done:
- Dead settings removed (`allow_self_approval` in DB, hook type, and Settings UI).
- Dead client rules removed for the *approval decision*; the per-row authority is
  now purely a projection of server state.
- Structural verification queries run for Waves 1–4 (results recorded above).
- Build green after each change.

Pending (this is where the next agent starts):
1. **Behavioural test pass.** Not yet executed — the tenant has 0 timesheets /
   0 submissions, so these need a disposable seeded fixture (org + employee +
   manager + period) and teardown:
   - self-approval blocked in `standard` mode;
   - auto-allowed in `solo` mode;
   - allowed once with a valid override, then re-blocked after the override is consumed;
   - manager vs non-manager approval (competence path);
   - concurrent approve is idempotent under `FOR UPDATE`;
   - locked-period mutation refused;
   - event emitted exactly once per idempotency key and the registered subscriber ran
     (assert on `business_event_outbox` + the projected `projects.spent_hours` /
     `payroll_runs.needs_recompute_reason`).
2. **Screen-level gate review.** `TimesheetApprovals` (`!canApproveTimesheets && !isManager`)
   and `TeamTimesheets` still derive *screen visibility* from client permissions. That is
   acceptable as a navigation affordance, but confirm the server refuses the same access
   (RLS + RPC competence check) so the gate is decoration and not the control.
3. **Duplicated totals check.** Confirm `trg_timesheet_to_cost` / `trg_timesheets_billing`
   do not write project cost or billing state that a Wave 3 subscriber now also writes —
   exactly one write path per value.

## Handoff — instructions for the next agent

1. **Verify before you build.** Re-run the structural checks behind the "verified"
   claims above before extending anything: confirm `guard_timesheet_self_approval`
   passes the org, `timesheet_settings.allow_self_approval` is gone, no timesheet RPC
   decides self-action, `invoice_project_timesheets` is only a wrapper, and every
   `timesheet.*` topic still resolves to a push subscriber or a recorded pull decision.
   If any check fails, fix that regression before new work.
2. **Then resume at Wave 5 item 1** (behavioural test pass), then items 2 and 3.
   Do not start a new domain while Wave 5 is open.
3. **Close Wave 5 properly**: no orphaned topics, no duplicated write paths, no dead
   settings or client rules, and the security linter count unchanged (baseline: 3711
   pre-existing project-wide issues; none introduced by this work).
4. Only after Wave 5 closes does the roadmap move on — the next domain follows the
   same method: verify current state by query first, name one authority per
   responsibility, then migrate.
