# Timesheets — Handover Verification Verdict (2026-08-26) and Wave 5 Closure

## Phase 1 — verification result (queried against the live database, not the notes)

Confirmed genuinely landed:

- **Governance boundary (Wave 1).** `guard_timesheet_self_approval` resolves the employee's
  user and calls `governance_assert_not_self(..., 'timesheet.approve', organization_id, ...)`
  with the real org; trigger `sod_timesheet_submissions_guard` is attached to
  `timesheet_submissions`. `timesheet_settings` no longer has an `allow_self_approval`
  column, and `approve_timesheet_submission` explicitly defers the self-action verdict to
  Governance. One authority for "may this person approve their own time".
- **Server-authoritative capability (Wave 2).** `governance_self_action_verdict` and
  `timesheet_approval_capability` exist and mirror enforcement read-only
  (`not_self`/`allow`/`warn`/`override_available` → block).
- **Event boundary (Wave 3).** All seven `timesheet.*` topics are registered. Nine active
  subscriptions route `approved`/`rejected`/`corrected`/`locked`/`unlocked` to handlers that
  live in Projects and Payroll; `submitted` and `billable_ready` are deliberate pull topics.
- **Invoice engine removed (Wave 4).** `invoice_project_timesheets` is now a one-line wrapper
  over `sales_invoice_project_timesheets`; Timesheets no longer constructs invoices.

Claims that did **not** survive verification:

1. **Project-manager approval is not implemented.** The plan states `_timesheet_can_approve`
   covers "admin / hr_admin / direct manager / project manager". The live function checks only
   `has_role(admin)`, `has_role(hr_admin)` and direct `manager_id`. `_timesheet_is_project_manager`
   exists but is referenced by no other function — a dead helper, and a real capability gap:
   an RLS policy (`timesheets_select_project_manager`) lets a PM *see* project time they cannot act on.
2. **Approval competence is hardcoded to two role names.** `admin` / `hr_admin` are baked into the
   function rather than resolved from the permission catalogue the rest of the product uses, so an
   org cannot grant or withhold timesheet approval without changing SQL.
3. **Nothing has been exercised.** The tenant holds 0 timesheets and 0 submissions, so no
   lifecycle claim — approval, self-action block, override consumption, event dispatch,
   downstream recompute — has ever run end to end.

## Wave 5 closure — the work that remains

**5.1 Fix the approval-competence gap (correctness, before testing).**
Rebuild `_timesheet_can_approve` around one authority: a permission check
(`timesheets.approve` in the existing permission model) plus the two structural relationships —
direct manager, and project manager via `_timesheet_is_project_manager` for the projects on the
submission. Role names stop being hardcoded; the seeded defaults keep admin/HR working as today.
`timesheet_approval_capability` inherits the same function, so the UI badge and the enforced
decision cannot diverge.

**5.2 Behavioural proof on a disposable fixture.**
Seed org + employee + manager + project manager + project + period via migration, then assert:
self-approval blocked in `standard` mode; auto-allowed in `solo`; allowed exactly once with a
valid override then re-blocked; manager and project-manager approve, unrelated user refused;
concurrent approve idempotent under `FOR UPDATE`; locked-period mutation refused; each event
emitted once per idempotency key with the subscriber's projection visible
(`projects.spent_hours`, `payroll_runs.needs_recompute_reason`).

**5.3 One write path per value.**
`trg_timesheet_to_cost` writes `project_cost_entries` per row while the Wave 3 subscriber writes
`projects.spent_hours`. Confirm these are distinct facts with distinct owners and that no third
path (client aggregation or a Projects trigger) recomputes either; delete whichever duplicate exists.

**5.4 Screen gates are decoration, not control.**
`TimesheetApprovals` and `TeamTimesheets` gate on client permissions. Prove the server refuses the
same access (RLS + the rebuilt competence function) so the client gate is only an affordance.

**5.5 Cleanup.**
Remove any helper left dead after 5.1/5.3, keep the security-linter count at its 3711 baseline,
and record the closure verdict here.

## Technical notes

- Every step lands as migration + code change + a verification query whose result is recorded
  in this file; no half-migrated state and no legacy fallbacks.
- Governance remains the sole authority for *who may act*; Timesheets owns only the state of the
  time record; Payroll/Projects/Sales/Finance decide what approved time means.
