# HR Lifecycle Map

Companion to `HR_DOMAIN.md`. This file traces the **actual code paths** that
move HR data from creation to payslip, so future audits don't have to re-walk
the migrations. Updated 2026-06-09 as Wave 1 of the production-readiness
audit (see `.lovable/plan.md`).

The intent is operational, not architectural — every entry names the table,
function, or RPC that owns the transition. If you change one of those, you
also change this file.

---

## 1. Identity & permission graph

```
auth.users ──┬── profiles (1:1, id = auth.users.id)
             │
             ├── user_business_access (org+business membership)
             ├── user_roles            (role + user_type per org)
             ├── member_permission_groups (RBAC groups per org)
             ├── user_branch_assignments (branch scoping)
             │
             └── employees.user_id  (HR-domain link, nullable until claimed)
```

Invariants (verified 2026-06-09):
- `employees_user_id_organization_id_unique` (UNIQUE) — one employee row per
  user per org.
- `employees_user_business_unique` (UNIQUE WHERE user_id IS NOT NULL) — one
  employee per user per business.
- `idx_unique_pending_invite` (UNIQUE WHERE accepted_at IS NULL) — no two
  pending invites per (org, lower(email)).
- `link_employee_to_user(p_employee_id, p_user_id)` is the **only** sanctioned
  way to set `employees.user_id` outside `accept-invitation`.
  `unlink_employee_from_user(p_employee_id)` is the inverse.

---

## 2. Employee onboarding lifecycle

```
HR creates employee row
   │
   ├── trigger: auto_create_default_onboarding   → employee_onboarding(_items)
   │                                                seeds statutory checklist
   │                                                from pack_requirements (single source of truth)

   │
   ├── HR fires invitation
   │     └── organization_invitations insert
   │           └── send-invitation-email fn → email_event_outbox
   │
   ├── Invitee opens link → validate-invitation fn (token + expiry)
   │
   └── accept-invitation fn (service role):
         1. Re-validate token / expiry / not-accepted
         2. Optional admin.createUser + profiles row
         3. Upsert user_roles (refuses to demote privileged user — 409)
         4. Auto-link employees.user_id via case-insensitive email match
            (skipped if existing role is owner/admin/super_admin)
         5. Assign permission_groups from invitation, or fall back to
            "Portal User" / "Internal User" system group
         6. Mark invitation accepted_at
         7. audit_logs: action='user_joined'
```

Edge cases the current code handles:
- Privileged-role demotion via portal invite → 409 (`would_demote_admin`).
- Duplicate accept (replay) → second call returns 400 "already accepted".
- Email mismatch on existing-user accept → 400.

Edge cases **NOT** yet covered (Wave 2 targets):
- Step 3-6 are not in a single transaction. A failure between role insert
  and invitation-mark-accepted leaves an accepted-but-unmarked invitation.
- Auto-link uses `ilike(email)` — if an employee row has a typo in email,
  no link happens silently (no warning surfaced).
- No `employees.user_id` reverse-uniqueness across orgs (multiple orgs can
  each have an employee linked to the same auth user — intentional, but
  worth documenting).

---

## 3. Attendance → payroll

```
attendance_clock_in / attendance_clock_out RPCs
   │  (RLS: own row or attendance.write)
   ▼
attendance rows  (one per day per employee, source-of-truth for hours)
   │
   ├── attendance_events  (append-only event log, blocked from mutation by
   │                       attendance_events_block_mutation trigger)
   │
   ├── attendance_corrections  (proposed edits; require approval)
   │     └── on approval → notify_attendance_decision +
   │                       audit_logs +
   │                       updates attendance row
   │
   ├── overtime_requests  (manager approval gates OT into payslip)
   │
   └── attendance_close_period RPC → locks the period so
         prevent_locked_attendance_edit trigger blocks further mutation
```

Branch scoping is enforced by RLS + `assertHrScope` dev-warning in hooks.

---

## 4. Timesheets → payroll

```
timesheets rows  (line-level entries; project/task scoped)
   │
   ├── tg_timesheet_snapshot_cost_rate trigger → freezes cost rate at submit
   │
   ├── timesheet_submissions  (header; state machine: draft→submitted→
   │                            approved|rejected)
   │
   └── tg_prevent_locked_timesheet_mutation trigger blocks edits when locked
```

Engine gate (compute-payroll, guarded by
`src/test/architecture/payroll-stage7-diagnostics.test.ts`):
- For employees with `time_tracking_source = 'timesheets'`, the engine
  queries `timesheets` within the pay period.
- Emits `TIMESHEETS_NOT_APPROVED` / `TIMESHEETS_MISSING` blocker rows into
  `payroll_run_issues` and `continue`s past the employee — no silent zero.

---

## 5. Payroll lifecycle

```
1. Pre-flight
   evaluate_payroll_readiness(org, business, run?)
   └── walks payroll_readiness_rules (14 active core rules, all severity=block
       except has_statutory_identifiers / has_payment_info = warn)
   └── payroll_readiness_eval_rule executes per-rule checks; custom rules
       use predicate_sql

2. Run
   payroll_runs insert (status='draft')
   └── compute-payroll edge fn:
        • resolveEmployeeCountry per employee  (multi-jurisdiction)
        • iterates empRules slice (NOT global statutoryRules)
        • timesheet gate (see §4)
        • inserts payslips + payslip_lines (shape pinned by
          payroll-payslip-shape.test.ts)

3. Review → approve
   status='approved' (lifecycle helpers in src/lib/payroll/runLifecycle.ts;
   canReverseRun is the single source of truth — guarded by
   payroll-reverse-eligibility.test.ts)

4. Post to GL
   post-payroll-gl edge fn:
        • countryByRule map (per rule_code, NOT once per run)
        • payroll_required_gl_mappings_for_run(p_run_id) for blockers
        • writes journal_entries via single-source helpers (Wave 5 guard:
          payroll-no-default-accounts-reads.test.ts)

5. Pay
   payroll_payment_batches / payroll_payment_batch_items

6. Audit
   log_payroll_audit triggers on every payroll write surface
   (R2 audit-trail guard)

7. Reverse (if needed)
   reverse-payroll edge fn writes a reversal run + GL reversal entries
```

Statutory returns pull templates from
`localization_pack_return_templates` (Stage-C data-driven guard).

---

## 6. Self-service (`MeApp`, `/me/*`)

Routes for a portal-only user:

| Path                | Source data                              | Notes                          |
| ------------------- | ---------------------------------------- | ------------------------------ |
| `/me/profile`       | `employees` filtered to own `user_id`    | Read-only by default           |
| `/me/leave`         | `leave_requests` + `leave_allocations`   | Create + list own              |
| `/me/attendance`    | `attendance` + `attendance_corrections`  | Clock in/out + correction req. |
| `/me/timesheets`    | `timesheets` + `timesheet_submissions`   | Draft/submit                   |
| `/me/payslips`      | `payslips` (RLS: own employee_id)        | PDF via `generate-payroll-document`, reads `pos_receipt_snapshots`-equivalent for payroll: payslip snapshot |
| `/me/loans`         | `employee_loans` + `loan_repayments`     | Read own + schedule            |
| `/me/notifications` | `notifications`                          |                                |
| `/me/documents`     | `employee_documents`                     | RLS scoped                     |

Gate: `OwnProfileOrPermissionRoute` (see `MeApp`) — portal users never
enter an HR `AppShell`.

---

## Known backlog (priority-ordered, post-Wave-1)

Each item turned into a tracked fix wave. Status reflects what has been
shipped against this audit (2026-06-09).

1. ✅ **Onboarding visibility — auto-link miss is no longer silent** (Wave 2).
   `accept-invitation` now calls `record_invitation_link_outcome` after the
   employee match attempt. Successes write a `completed` row to
   `onboarding_attempts`; failures write a `failed` row with reason
   `no_employee_match` and a remediation hint, all keyed by a stable
   idempotency key (`invite_link:<user>:<org>`). HR can list orphan portal
   users by querying `onboarding_attempts WHERE status='failed' AND
   diagnostics->>'source'='accept-invitation'`. Guard:
   `src/test/architecture/hr-audit-waves.test.ts`.
2. ⏭️ **Onboarding transaction boundary** — deferred. Each step in
   `accept-invitation` is idempotent on its own and the auto-link diagnostic
   above means partial failures are now visible. Wrapping the whole flow in
   a single SQL function would re-implement the auth.admin.createUser path
   server-side and is a Wave-9 candidate, not a defect.
3. ✅ **Overtime → engine** verified clean. `compute-payroll` already caps
   overtime by approved `overtime_requests` (`Employee X: Yh overtime
   excluded — no approved overtime_request`) and falls back to attendance
   `overtime_hours`. No FK to `work_entry_types` is needed; the engine never
   reads one. Existing test:
   `src/test/architecture/payroll-stage7-diagnostics.test.ts`.
4. ✅ **Timesheet submission state machine** (Wave 4). Migration installs a
   CHECK constraint pinning the legal status set and a `BEFORE INSERT OR
   UPDATE OF status` trigger (`tg_timesheet_submission_state_machine`) that
   rejects illegal transitions, makes `locked` terminal, and fills
   approval/rejection timestamps. Guard:
   `src/test/architecture/hr-audit-waves.test.ts`.
5. ⏭️ **Payroll readiness severity tuning** — left at `warn` intentionally.
   Promoting `employee.has_payment_info` to `block` should be a per-org
   policy switch (some orgs do cash payroll), not a global change. Filed as
   backlog for the org-policy work, not a defect.
6. ✅ **Self-service payslip snapshot** verified clean. `MyPayslips.tsx`
   reads directly from the `payslips` table (immutable snapshot of period
   totals + lines) and invokes `generate-payslip-pdf` for the PDF — no live
   recompute path exists. Existing guard:
   `src/test/architecture/portal-payslip-contract.test.ts`.
7. ⏭️ **HR admin entry-point consolidation** — `BulkActionBar` +
   `EmployeeInviteDialog` are already the single mount points (verified via
   `rg`). No duplicates to consolidate. Closed.

### Open follow-ups (not blockers)

- ✅ **Per-org payroll severity override** — `payroll_readiness_rule_overrides`
  table + updated `payroll_readiness_blockers` honour the override so HR can
  flip `employee.has_payment_info` (or any `warn`) to `block` per organization
  without code changes. Migration 20260609_0858.
- ✅ **`accept_organization_invitation_atomic`** — single SQL function fuses
  role upsert + employee link + permission groups + invitation accepted_at +
  `record_invitation_link_outcome` into one transaction. `auth.admin.createUser`
  stays in the edge function (outside the txn). Edge function now delegates
  to the RPC. Migration 20260609_0858.
- ✅ **HR ops onboarding-issues page** — `/hr/onboarding-issues` lists failed
  `onboarding_attempts` for the active org via `hr_list_failed_onboarding_attempts`
  (security-definer, admin-only). Surfaces the Wave-2 diagnostic without
  ad-hoc queries.

All audit waves are now resolved or explicitly closed.




---

## Out of scope for this audit

- Recruitment app (status: coming soon).
- Cosmetic redesigns beyond confusion blockers.
- Performance/training surfaces beyond their existing test guards.
