## Scope

Execute the two follow-ups from the previous plan that were previously deferred:

1. Promote **invite / invitation-accepted / link / unlink** into first-class rows in `employee_lifecycle_events` so the Employee timeline reflects identity transitions like every other lifecycle change (hire, promote, terminate…).
2. Convert `employees.user_access_status` from a **client-maintained** column into a **DB-maintained derived** column driven by the source-of-truth state (`employees.user_id` + `organization_invitations`).

No architectural redesign of Employee ≠ User. No signature-breaking changes to existing RPCs. All new RPC parameters are added with defaults so existing callers keep working.

## Part A — Identity lifecycle events

### A1. Extend the enum

Add to `employee_lifecycle_event_type`:

- `user_invited`
- `user_invitation_revoked`
- `user_invitation_accepted`
- `user_linked`
- `user_unlinked`

### A2. Explicit invitation → employee link

`organization_invitations` currently associates to an employee only by email match at accept time. Add:

- `employee_id uuid NULL REFERENCES public.employees(id) ON DELETE SET NULL`
- Partial index `(organization_id, employee_id) WHERE accepted_at IS NULL AND employee_id IS NOT NULL` to enforce "one open invite per employee".

Backfill: `UPDATE organization_invitations i SET employee_id = e.id FROM employees e WHERE i.employee_id IS NULL AND e.organization_id = i.organization_id AND lower(e.work_email) = lower(i.email)` — best-effort, no failure on ambiguous rows.

External invites (e.g. an external accountant with no HR record) keep `employee_id NULL`; the email-fallback path remains supported.

### A3. RPC changes (backward-compatible)

- `upsert_organization_invitation` — add trailing param `p_employee_id uuid DEFAULT NULL`. When provided (or resolvable by exact `work_email` match), stored on the row **and** an `user_invited` event is inserted into `employee_lifecycle_events` with `source_table='organization_invitations'`, `source_id=<invitation id>`, `actor_user_id=v_caller`, payload `{email, role, user_type, permission_group_ids}`.
- `accept_organization_invitation_atomic` — after the atomic acceptance succeeds, if the invitation resolves to an employee (FK first, email fallback second) emit `user_invitation_accepted` and, whenever `employees.user_id` was set as part of accept, emit `user_linked`. Both events tagged with the acceptor as `actor_user_id`.
- `link_employee_to_user` — after the successful UPDATE, emit `user_linked` with `payload={target_user_id, forced}`.
- `unlink_employee_from_user` — after the successful UPDATE, emit `user_unlinked` with `payload={former_user_id}`.
- Add revocation RPC `revoke_organization_invitation(p_invitation_id uuid)` that soft-invalidates a pending invite (existing UI already exposes a revoke path via direct DELETE; we keep it but wrap in the RPC so the `user_invitation_revoked` event is recorded). If no such delete/revoke UI exists today, this RPC still ships for completeness — audit continuity is the point.

All emits are SECURITY DEFINER inside the same functions — no new triggers, no fan-out, no risk of double-emit.

### A4. Client wiring

- `EmployeeInviteDialog` passes `p_employee_id: employee.id` to `upsert_organization_invitation`.
- No other client change needed — link/unlink already funnel through the RPCs.

## Part B — Derive `user_access_status`

### B1. Compute function

`public.compute_employee_user_access_status(p_employee_id uuid) RETURNS text` returns:

- `'active'` if `employees.user_id IS NOT NULL`
- else `'invited'` if a matching row exists in `organization_invitations` where `accepted_at IS NULL AND expires_at > now()` (match on FK first, then email)
- else `'none'`

### B2. Trigger maintenance

- `_employees_user_access_status_before_iu` — `BEFORE INSERT OR UPDATE OF user_id ON employees`: sets `NEW.user_access_status := compute(...)`.
- `_invitations_touch_employee_access_status` — `AFTER INSERT OR UPDATE OF accepted_at, expires_at, employee_id, email OR DELETE ON organization_invitations`: recomputes and UPDATEs the affected employee row's `user_access_status` (bounded, single-row update via the FK, or email match when FK is null).

### B3. Backfill

Single UPDATE that runs the compute function for every existing employee row so the column matches the derived truth immediately after the migration.

### B4. Remove client writes

- `src/components/employees/EmployeeInviteDialog.tsx` — drop the `user_access_status: "invited"` field from the payload.
- `src/components/employees/EmployeeHRSettings.tsx` — drop the manual `.update({ user_access_status: "active" })` fallback; the trigger handles it.

Column stays present, still nullable-safe, still typed the same — reads keep working, types.ts doesn't need edits.

## Part C — Regression guards

New pgTAP files under `supabase/tests/`:

- `employee_identity_events_test.sql` — asserts the 5 new enum values exist, `organization_invitations.employee_id` exists with the ON DELETE SET NULL FK, and the four RPCs still have the expected identities.
- `employee_user_access_status_derived_test.sql` — inserts a fixture employee, asserts status is `'none'`; inserts a pending invitation with matching `employee_id`, asserts status flips to `'invited'`; sets `employees.user_id`, asserts `'active'`; nulls `user_id`, asserts `'invited'` again (invite still open); marks invite `accepted_at=now()`, asserts `'active'` if user_id set else `'none'`.

## Part D — Out of scope (still)

- Merging Employee ↔ User tables.
- Changing portal↔internal isolation semantics (`prevent_portal_group_assignment` stays).
- Removing `permission_group_ids` or reshaping permission groups.
- Any UI redesign of the Employee actions menu.
- Payroll / Time Off / Attendance / Recruitment.

## Files & migrations

- One migration: enum values, `organization_invitations.employee_id` + FK + partial index + backfill, `compute_employee_user_access_status`, two triggers, employee-row backfill, `CREATE OR REPLACE` of the four RPCs (`upsert_organization_invitation`, `accept_organization_invitation_atomic`, `link_employee_to_user`, `unlink_employee_from_user`), plus new `revoke_organization_invitation`.
- Client: `EmployeeInviteDialog.tsx` (add `p_employee_id`, drop `user_access_status` write), `EmployeeHRSettings.tsx` (drop `user_access_status` write).
- Tests: two new pgTAP files.
- `.lovable/plan.md` updated as tracker (short — not a design doc).

## Risk & rollback

- All identity-event emits live inside existing RPC bodies → deterministic, no async fan-out. If the pgTAP asserts fail post-migration, the `CREATE OR REPLACE` bodies can be reverted independently of the schema change.
- The `employee_id` FK is nullable and `ON DELETE SET NULL` → does not block any existing invite/delete flow.
- `user_access_status` remains a real column, so any consumer (types.ts, UI, hooks, reports) is unaffected. The only change is that clients no longer *write* it; the DB is now the sole author.
- Backfills are idempotent (both invitation.employee_id and employees.user_access_status) — re-running the migration in staging is safe.
