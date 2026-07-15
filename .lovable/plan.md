# Employee Identity Lifecycle — execution tracker

Source of truth is the codebase + `supabase/tests/*`. This file is a short
handoff, not a design doc.

## Architecture (verified against implementation)

```
employees ──(FK employee_id)──> organization_invitations ──(accept)──> auth.users
    │                                     │                              │
    │                                     ▼                              ▼
    │                         permission_group_ids[]         user_roles + member_permission_groups
    │                                     │
    │                                     ▼
    └───────── employees.user_id (nullable back-link) ◄─── link_employee_to_user
                                                      ◄─── accept_organization_invitation_atomic
```

- Employee ≠ User is preserved.
- Single atomic acceptor: `accept_organization_invitation_atomic`.
- Portal ↔ internal isolation: `prevent_portal_group_assignment` trigger.
- Invitation → employee is now an explicit FK, with email-fallback preserved
  for external (non-employee) invites like an outside accountant.

## Phase 1 — RPC defect fixes (DONE)

| Function                              | Fix                                                                                             |
|---------------------------------------|-------------------------------------------------------------------------------------------------|
| `get_linkable_users_for_employee`     | Renamed CTE columns to `linked_user_id`/`admin_user_id`/`candidate_user_id`; ambiguity removed. |
| `upsert_organization_invitation`      | `COALESCE(p_permission_group_ids, ARRAY[]::uuid[])` honours the `NOT NULL DEFAULT '{}'` column. |

Guards: `supabase/tests/get_linkable_users_for_employee_test.sql`,
`supabase/tests/upsert_organization_invitation_test.sql`.

## Phase 2 — Identity events as first-class lifecycle rows (DONE)

- Added enum values on `employee_lifecycle_event_type`:
  `user_invited`, `user_invitation_revoked`, `user_invitation_accepted`,
  `user_linked`, `user_unlinked`.
- Added `organization_invitations.employee_id uuid REFERENCES employees(id)
  ON DELETE SET NULL`; partial unique index enforces one open invite per
  employee. Backfilled where the email uniquely resolves.
- RPCs now emit lifecycle rows:
  - `upsert_organization_invitation` — accepts `p_employee_id` (defaults to
    NULL, resolves from email otherwise), emits `user_invited` (or the
    `reused: true` variant on refresh).
  - `accept_organization_invitation_atomic` — resolves employee via FK
    first, email fallback second, emits `user_invitation_accepted` and, on
    successful link, `user_linked`.
  - `link_employee_to_user` — emits `user_linked` with `forced` flag.
  - `unlink_employee_from_user` — emits `user_unlinked`.
  - New `revoke_organization_invitation` RPC — soft-invalidates a pending
    invite (expires_at in the past) and emits `user_invitation_revoked`.
- `EmployeeInviteDialog` passes `p_employee_id` and no longer writes
  `user_access_status`.

Guard: `supabase/tests/employee_identity_events_test.sql`.

## Phase 3 — Derived `user_access_status` (DONE)

- `compute_employee_user_access_status(employee_id)` returns
  `active | invited | none` from (`employees.user_id`,
  `organization_invitations` open state).
- BEFORE INSERT/UPDATE trigger on `employees` derives the value on every
  row touch.
- AFTER trigger on `organization_invitations` (INSERT/UPDATE of accepted_at,
  expires_at, employee_id, email / DELETE) refreshes the affected employee
  row(s), keying on FK first and email second.
- Employees backfilled once at migration time.
- `EmployeeInviteDialog` and `EmployeeHRSettings` no longer write
  `user_access_status`. Reads unchanged; types.ts unchanged.

Guard: `supabase/tests/employee_user_access_status_derived_test.sql`.

## Out of scope (still)

- Merging Employee ↔ User tables.
- Reshaping permission groups / portal↔internal isolation.
- UI redesign of the Employee actions menu.
- Payroll / Time Off / Attendance / Recruitment.

## Verification order

1. Migration applied → linter noise is pre-existing project-wide, not from
   these functions.
2. pgTAP: run the four test files above; all must pass.
3. Playwright smoke: invite an employee with no permission groups selected
   → invitation row created with `permission_group_ids = '{}'` and
   `employee_id` populated; open Link User dialog → list loads with no
   ambiguity error; timeline shows the corresponding lifecycle events.
