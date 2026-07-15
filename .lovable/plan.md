# Employee Identity Lifecycle — execution tracker

Lightweight handoff, not a design doc. Source of truth is the codebase +
`supabase/tests/*`.

## Architectural verdict

Employee ≠ User separation is correctly modelled by the existing schema:

```
employees ──(optional)──> organization_invitations ──(accept)──> auth.users
    │                              │                                 │
    │                              ▼                                 ▼
    │                     permission_group_ids[]           user_roles + member_permission_groups
    │                                                                │
    └──────── employees.user_id (nullable back-link) ◄────────────────┘
```

Single atomic acceptor: `accept_organization_invitation_atomic`.
Portal isolation guard: `prevent_portal_group_assignment` trigger.
No architectural redesign required — the reported failures are local
defects inside otherwise-correct RPCs.

## Defects fixed

| # | Function                              | Root cause                                                              | Fix                                                                                         | Status |
|---|---------------------------------------|-------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|--------|
| 1 | `get_linkable_users_for_employee`     | CTE columns `pa.user_id` / `linked_elsewhere.user_id` shadowed the      | Rename to `admin_user_id` / `linked_user_id`; project candidates as `candidate_user_id`.    | DONE   |
|   |                                       | function's `RETURNS TABLE(user_id …)` → "column reference user_id       | Signature, callers, UI unchanged.                                                           |        |
|   |                                       | is ambiguous".                                                          |                                                                                             |        |
| 2 | `upsert_organization_invitation`      | Inserted `p_permission_group_ids` verbatim, but the column is           | `COALESCE(p_permission_group_ids, ARRAY[]::uuid[])`. UPDATE path keeps existing groups only | DONE   |
|   |                                       | `NOT NULL DEFAULT '{}'`. NULL from portal / "assign later" invites      | when caller passes NULL (no accidental erase). System-group fallback stays in the acceptor. |        |
|   |                                       | violated the constraint.                                                |                                                                                             |        |

## Regression guards

- `supabase/tests/get_linkable_users_for_employee_test.sql` — signature +
  return-column contract; asserts the ambiguous `SELECT user_id FROM pa|linked_elsewhere`
  cannot come back; asserts renamed columns are present.
- `supabase/tests/upsert_organization_invitation_test.sql` — signature +
  column invariants (`NOT NULL DEFAULT '{}'`); asserts the COALESCE is in
  the function body.

## Explicitly out of scope

- Merging Employee ↔ User.
- Removing `employees.user_access_status` (existing helper columns +
  pgTAP `employees_identity_uniqueness_test.sql` are sufficient).
- Replacing invitation-accept auto-link-by-email (intentional, Odoo-shape).
- `platform_admins`, `accept_organization_invitation_atomic`,
  `prevent_portal_group_assignment`, `user_roles`,
  `member_permission_groups`.
- Payroll / Time Off / Attendance / Recruitment.
- Any UI redesign of the Employee actions menu.

## Follow-ups (only if drift is later observed, not now)

- Promote invite / link / unlink events into `employee_lifecycle_events`
  so the Employee timeline reflects identity transitions.
- Collapse `employees.user_access_status` into a view derived from
  `user_id` + `organization_invitations` state.
