# Timesheets — Architecture Re-Audit and Controlled Migration

## Domain verdict (from first principles)

A timesheet is **the authoritative record of how an employee's working time was spent against a business context** (project / task / cost object). It owns the time record and its lifecycle only. It owns nothing downstream.

- Timesheets own: time entry data, entry validation, submission period, submit/approve/reject/correct/reverse state machine, lock state, audit history.
- Timesheets do not own: authorization policy (Governance), pay computation (Payroll), project cost interpretation (Projects), invoicing (Sales/Billing), accounting entries (Finance), notification delivery (Notifications), physical presence (Attendance).
- Timesheets produce events: `timesheet.submitted / approved / rejected / corrected / locked / unlocked / billable_ready`.
- Timesheets consume: employee + manager graph, project/task eligibility, org/branch scope, governance policy, payroll period lock state.

## Verified findings (queried this session, not taken from prior claims)

1. Lifecycle exists and is largely server-authoritative: tables `timesheets`, `timesheet_submissions`, `timesheet_settings`, `timesheet_audit_log`; RPCs `submit_timesheet_period`, `approve_timesheet_submission`, `reject_timesheet_submission`, `correct_timesheet_entry`, `reverse_timesheet_entry`, `lock_timesheets_for_payroll`; state-machine, lock-guard, period-guard, correction-supersede, cost-rate-snapshot and audit triggers all enabled. **Verdict: correct foundation.**
2. **Duplicated business authority on self-approval — confirmed.** `approve_timesheet_submission` reads `timesheet_settings.allow_self_approval` and decides via `_timesheet_can_approve(...)`, while trigger `sod_timesheet_submissions_guard → guard_timesheet_self_approval` independently calls `governance_assert_not_self('timesheet.approve')`. Two authorities, same decision. **Verdict: architecturally wrong / wrong ownership.**
3. **The Timesheet-local setting cannot ever take effect, and the Governance policy is bypassed too.** `guard_timesheet_self_approval` passes `p_org => NULL`. With a NULL org, `governance_assert_not_self` skips role lookup, `governance_mode`, `self_action_policy` and the override consumption path, and falls through to an unconditional `block`. Every other guard in the system (17 of them: expense, leave, bill, payment, loan, contract, journal, stock, PO, refund, …) passes the organization id. Timesheets is the sole outlier. **Verdict: defect — the settings toggle is a misleading UI, and governance overrides/modes are unreachable for timesheets.**
4. **`timesheet_settings` is read inconsistently.** `timesheet_effective_settings` resolves business-scoped then org-level rows; `approve_timesheet_submission` reads `organization_id` only and ignores `business_id` scoping. **Verdict: needs improvement.**
5. **Events are emitted into a void.** All 8 `timesheet.*` topics are registered in `business_event_topics` with consumer domains (payroll, projects, sales, finance, reporting, notifications), and `_timesheet_emit_event` writes to `business_event_outbox`, but `business_event_subscriptions` has **zero** timesheet rows. **Verdict: dead events / orphaned producer.**
6. **Timesheets is acting as an invoice engine.** `invoice_project_timesheets` inserts into `public.invoices` and `public.invoice_items` directly from the Timesheets domain. **Verdict: wrong ownership.**
7. Client-side authority leaks: `useTeamTimesheets` decides scope from `can("approveTimesheets")` + `directReports` locally; `TimesheetApprovals` gates the whole screen on client-derived `canApproveTimesheets || isManager`; `TimesheetSettings.tsx` presents `allow_self_approval` as if it were the deciding policy. **Verdict: duplicated rule engine in the UI.**
8. Current tenant is empty (0 timesheets, 0 submissions, 0 settings rows) and org `governance_mode = 'solo'` — so the migration carries no data-backfill risk, and solo-mode self-approval is *supposed* to be auto-allowed today but is being blocked by finding 3.

## Target architecture

```text
Employee → draft entry → submit  ─┐
                                  ├─ Timesheets: state machine + validation (owner)
Approver → approve/reject ────────┘        │
        │                                  ├─ authorization asked of Governance
        │                                  │   (self-action policy, org mode, overrides, SoD)
        └────────────────────────────► timesheet.* events → business_event_outbox
                                             │
        Payroll ◄── approved payable time ───┤ (payroll applies its own rules)
        Projects ◄── project hours/cost ─────┤
        Sales/Billing ◄── billable_ready ────┤ (Sales creates the invoice, not Timesheets)
        Finance ◄── labour cost/accrual ─────┤
        Notifications / Reporting ◄──────────┘
```

One authority per responsibility: **Governance decides *who may*; Timesheets decides *what state the time record is in*; downstream domains decide what the approved time means.**

## Work plan

### Wave 1 — Governance boundary (highest-value correction)
- Migration: rewrite `guard_timesheet_self_approval` to resolve and pass `NEW.organization_id`, matching all 17 sibling guards. This makes org governance mode, `self_action_policy('timesheet.approve')` and time-boxed overrides actually govern timesheet approval.
- Migration: strip the self-approval decision out of `approve_timesheet_submission` / `_timesheet_can_approve`. The RPC keeps only *competence* checks (admin / hr_admin / direct manager / project manager) and lifecycle checks; the *self-action* verdict comes solely from Governance.
- Migration: drop `timesheet_settings.allow_self_approval` (duplicate authority, currently inert, no rows to migrate) and remove it from the settings hook/type and the Settings screen. Replace it with a read-only line in Timesheet Settings pointing at the Governance self-action policy for `timesheet.approve`.
- Migration: make the RPC use business-scoped settings resolution (same precedence as `timesheet_effective_settings`).

### Wave 2 — Server-authoritative approval capability
- Add `timesheet_approval_capability(_submission_id)` (or extend the submissions read) returning `can_approve`, `requires_override`, `reason` computed server-side.
- `useTeamTimesheets` / `TimesheetApprovals` / `TimesheetApprovalList` consume that flag instead of recomputing permissions client-side; the screen gate becomes a projection of server state. Approve/reject buttons surface the governance reason (`GOV_SELF_ACTION` → override request path) instead of a raw error toast.

### Wave 3 — Reconnect the event boundary
- Register `business_event_subscriptions` handlers for the timesheet topics that have real consumers today (payroll lock/consumption, project cost, billable-ready, notifications, reporting), or retire topics that have no consumer. No topic may remain with an emitting producer and no subscriber.
- Verify `trg_timesheet_to_cost` and `trg_timesheets_billing` against the chosen boundary so project cost / billing state has exactly one write path.

### Wave 4 — Remove the invoice engine from Timesheets
- Move `invoice_project_timesheets`'s invoice creation into the Sales/Billing domain, driven by `timesheet.billable_ready` + an explicit Sales action. Timesheets keeps only `mark_timesheets_invoiced` (its own record's invoiced state, called by Billing).

### Wave 5 — Cleanup and verification
- Remove dead settings, dead client rules, and duplicated totals; confirm no legacy fallback remains.
- Tests: self-approval blocked in `standard` mode, auto-allowed in `solo` mode, allowed once with a valid override and then re-blocked (override consumed); manager-vs-non-manager approval; concurrent approve is idempotent under `FOR UPDATE`; locked-period mutation refused; event emitted exactly once per idempotency key and picked up by a subscriber.

## Notes on scope
Attendance, Payroll internals, Projects internals and Finance posting rules are inspected only where the timesheet dependency graph reaches them (Waves 3–4). No rewrite of those domains.
