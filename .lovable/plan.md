## Verified current state

```text
Employee
  -> organization_invitations(employee_id, permission_group_ids, role, user_type)
  -> accept_organization_invitation_atomic
  -> user_roles + member_permission_groups
  -> employees.user_id link
  -> employee_lifecycle_events + audit_logs
  -> /me self-service and manager-scoped workflows
```

**Facts already verified in the live database/source:**
- Fredrick has exactly one pending invitation row, linked to employee `5449cd48-bbf2-42da-a279-907ac2dfc9ce`; repeated sends refresh the same invite, not create duplicates.
- `platform_email_logs` has no rows for `nkathavictor26@gmail.com`, so the email sender is not being reached.
- Local `send-invitation-email` source already removed the invalid `business_id` select and now has better error surfacing, but the user is still seeing the old `{"error":"Invitation not found"}` behavior.
- The live database has both the old 7-argument and new 8-argument `upsert_organization_invitation` overloads. The 8-arg version supports `employee_id` and lifecycle events; the old overload is architectural drift.
- The live `get_linkable_users_for_employee` body is already disambiguated (`candidate_user_id`, `linked_user_id`, `admin_user_id`), so the original ambiguous `user_id` defect appears fixed in DB shape, but still needs runtime/caller verification.

## Implementation plan

### 1. Convert `.lovable/plan.md` into a lightweight execution tracker
- Replace the stale handoff narrative with a concise verified/unverified checklist.
- Record only operational facts, blockers, and remaining tasks; no large architecture document.

### 2. Fix the current invitation email failure at the deployed edge layer
- Deploy the current `send-invitation-email` edge function so live behavior matches source.
- Call it with Fredrick’s existing invitation ID using an authenticated session.
- Verify one of two outcomes:
  - success path: `send-email` runs and `platform_email_logs` gets a row; or
  - real failure path: the function returns/logs the actual provider/config error instead of masking it as “Invitation not found”.
- If `send-email` fails, inspect that function’s logs and sender configuration next; do not alter invitation semantics to hide delivery failure.

### 3. Remove invitation RPC overload drift safely
- Add a database migration to drop the obsolete 7-argument `upsert_organization_invitation` overload after confirming no current caller requires it.
- Keep the canonical 8-argument RPC as the single write entry point for employee-linked invitations.
- Update/extend regression tests so the old overload cannot reappear silently.

### 4. Harden invitation resend UX and diagnostics
- Verify `EmployeeInviteDialog` always passes `p_employee_id` and always inspects `supabase.functions.invoke` errors.
- Preserve the enterprise semantics:
  - portal invitations may carry no access groups;
  - internal invitations may specify access groups;
  - missing internal groups falls back during acceptance to the default internal group.
- Make the UI distinguish “invitation saved but email failed” from “email sent”.
- Show the existing pending invitation state where the employee action surface can see that only one invite exists.

### 5. Runtime-verify employee linking architecture
- Exercise `get_linkable_users_for_employee` through the real UI/session path.
- Verify `EmployeeLinkDialog` uses only the server-side candidate RPC and does not read identity tables directly.
- Verify `link_employee_to_user` / `unlink_employee_from_user` remain the only employee `user_id` write paths and still emit lifecycle events.
- If the ambiguous `user_id` error still appears at runtime, fix the deployed function body/migration state rather than patching the dialog.

### 6. Regression protection
- Add/adjust tests for:
  - canonical invitation RPC signature only;
  - no direct `employees.user_id` mutations from app code;
  - invite send failure surfaces to the user;
  - pending invite reuse does not duplicate rows;
  - employee lifecycle events are emitted for invite, accept, link, unlink, revoke.

### 7. Final validation
- Re-send Fredrick’s invitation once.
- Confirm:
  - still one pending invitation row;
  - `expires_at` refreshed;
  - `platform_email_logs` contains the send or a real provider rejection;
  - browser toast reflects the true outcome;
  - no recurrence of `permission_group_ids` NOT NULL or ambiguous `user_id` errors.

## Architectural direction to preserve

```text
Employee is the HCM person record.
User/Auth is the system identity.
Invitation is the provisioning event between them.
Permission groups/access groups grant internal application capabilities.
Portal users get employee self-service without being treated as internal staff.
Lifecycle events are business events and must remain auditable.
```

No table merge, no Employee/User collapse, no client-side identity assembly, and no silent email-send success.