## Scope

Fix the two failing RPCs at the correct architectural layer, add regression guards, and align the surrounding Employee → Invitation → User linkage flow with the existing (correct) Employee ≠ User separation. No architecture markdown will be produced — the codebase, migrations, and pgTAP tests are the source of truth. `.lovable/plan.md` stays as the lightweight handoff tracker.

## Architectural verdict (from tracing the code)

The current model is sound and matches Workday/Odoo/Dynamics shape:

```text
employees ──(optional)──> organization_invitations ──(accept)──> auth.users
    │                              │                                 │
    │                              ▼                                 ▼
    │                     permission_group_ids[]           user_roles + member_permission_groups
    │                                                                │
    └──────── employees.user_id (nullable back-link) ◄────────────────┘
```

Single atomic acceptor: `accept_organization_invitation_atomic`. Portal isolation guard: `prevent_portal_group_assignment`. Employee stays authoritative HR record; user account is a separate, later, optional identity. This is preserved.

The two failures are **implementation defects inside otherwise-correct functions**, not architectural flaws. Fix them at the SQL layer, don't redesign.

## Defect 1 — `get_linkable_users_for_employee`

**Root cause:** CTEs `linked_elsewhere` and `pa` (platform_admins) both project a `user_id` column that collides with the outer `RETURNS TABLE(user_id …)` in the final SELECT's `WHERE u.id IN (…)` / `NOT IN (…)` clauses → Postgres raises *column reference "user_id" is ambiguous*.

**Fix:** rename the CTE projections to `linked_user_id` / `admin_user_id`, keep every design property intact:
- HR-permission gate (caller must have `manage_employees` or be org admin/owner)
- Server-side classification (`already_linked_to_this_employee`, `linked_to_other_employee`, `platform_admin`, `portal_user`, `available`)
- Email masking for non-HR viewers
- Block reasons returned to UI so the dialog can disable rows with tooltip

No signature change. No caller change. No UI change.

## Defect 2 — `upsert_organization_invitation` NOT NULL on `permission_group_ids`

**Root cause:** column is `NOT NULL DEFAULT '{}'` but the RPC inserts `p_permission_group_ids` verbatim. Portal invites and "assign groups later" flows pass NULL → constraint violation. The downstream `accept_organization_invitation_atomic` already implements the correct fallback (empty array → auto-assign "Internal Users" system group at accept time), so the writer just needs to normalise NULL → `{}`.

**Fix:** `COALESCE(p_permission_group_ids, ARRAY[]::uuid[])` on both INSERT and UPDATE paths inside the RPC. Permission-group *policy* (portal isolation, system-group fallback, inheritance) stays where it belongs — in the acceptor and the `prevent_portal_group_assignment` trigger. No schema change; the `NOT NULL DEFAULT '{}'` invariant is preserved and now actually honoured by the writer.

## Deliverables

1. **Migration** — `CREATE OR REPLACE FUNCTION` for both RPCs only. No table changes, no policy changes, no signature changes.
2. **pgTAP regression tests** under `supabase/tests/`:
   - `get_linkable_users_for_employee_test.sql` — asserts: runs without ambiguity error; classifies already-linked / cross-linked / platform-admin / portal / available correctly; masks email for non-HR; rejects unauthorised caller.
   - `upsert_organization_invitation_test.sql` — asserts: NULL `p_permission_group_ids` inserts as `{}`; explicit array is preserved; UPDATE path also coalesces; portal-scope invite still blocked from internal groups by the existing trigger.
3. **Runtime validation** — Playwright smoke against localhost: open Employee → *Link User Account* dialog (list loads, no 500) and Employee → *Invite to System* with no groups selected (invitation row created, `permission_group_ids = '{}'`).
4. **`.lovable/plan.md`** updated as a short execution tracker (defects, fixes, test names, verification status) — no long-form design doc.

## Explicitly not doing (out of scope per user's "no long docs, no destructive redesign unless needed")

- Merging Employee ↔ User.
- Removing `employees.user_access_status` or converting it to a view (deferred; separate follow-up if drift is observed).
- Replacing invitation-accept auto-link-by-email (current behaviour is intentional and matches Odoo).
- Touching `platform_admins`, `accept_organization_invitation_atomic`, `prevent_portal_group_assignment`, portal↔internal isolation, `user_roles`, `member_permission_groups`.
- Payroll / Time Off / Attendance / Recruitment.
- Any UI redesign of the Employee actions menu.

## Risk & backward compatibility

- Both changes are `CREATE OR REPLACE FUNCTION` with identical signatures → zero client-side impact, zero migration downtime, trivially revertible.
- No data backfill required (existing rows already satisfy `permission_group_ids NOT NULL`).
- pgTAP guards prevent silent regression if either function is edited again.

## Technical details

Files touched:
- `supabase/migrations/<ts>_fix_employee_identity_rpcs.sql` — two `CREATE OR REPLACE FUNCTION` bodies.
- `supabase/tests/get_linkable_users_for_employee_test.sql` (new).
- `supabase/tests/upsert_organization_invitation_test.sql` (new).
- `.lovable/plan.md` — tracker update only.

Verification order: migration → pgTAP green → Playwright smoke on both dialogs → mark plan items done.
