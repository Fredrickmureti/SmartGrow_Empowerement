## Employee identity lifecycle execution tracker

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
- `send-invitation-email` source removes the invalid `business_id` select and returns/logs lookup/send failures with real diagnostics.
- The corrected `send-invitation-email` edge function has been deployed.
- The live database now has only the canonical 8-argument `upsert_organization_invitation` overload. The obsolete 7-argument overload was dropped.
- The live `get_linkable_users_for_employee` body is already disambiguated (`candidate_user_id`, `linked_user_id`, `admin_user_id`), so the original ambiguous `user_id` defect appears fixed in DB shape, but still needs runtime/caller verification.
- Direct unauthenticated `send-invitation-email` invocation returns 401 as expected; authenticated runtime verification is blocked in the sandbox because this project uses external unmanaged auth.
- A database trigger now blocks direct `employees.user_id` inserts/updates unless the write is marked by a sanctioned identity lifecycle RPC.
- `accept_organization_invitation_atomic` now preserves the newly-created-member path and marks employee linking as a sanctioned identity lifecycle source.

## Implementation plan

### 1. Convert `.lovable/plan.md` into a lightweight execution tracker — DONE
- This file now records verified facts, completed changes, blockers, and remaining validation only.

### 2. Fix the current invitation email failure at the deployed edge layer — PARTIAL
- DONE: deployed the current `send-invitation-email` edge function so live behavior matches source.
- DONE: verified unauthenticated calls return 401, proving the deployed handler is reachable and protected.
- BLOCKED: authenticated edge invocation cannot be performed from this sandbox (`LOVABLE_BROWSER_AUTH_STATUS=external_unmanaged`, no preview token injected). The user must retry from the app session, or an engineer must test with an explicit valid user JWT.
- On retry, verify one of two outcomes:
  - success path: `send-email` runs and `platform_email_logs` gets a row; or
  - real failure path: the function returns/logs the actual provider/config error instead of masking it as “Invitation not found”.
- If `send-email` fails, inspect that function’s logs and sender configuration next; do not alter invitation semantics to hide delivery failure.

### 3. Remove invitation RPC overload drift safely — DONE
- DONE: dropped the obsolete 7-argument `upsert_organization_invitation` overload.
- DONE: canonical 8-argument RPC remains the single invitation write entry point.
- DONE: `supabase/tests/upsert_organization_invitation_test.sql` now asserts only one overload exists.

### 4. Harden invitation resend UX and diagnostics — DONE
- DONE: `EmployeeInviteDialog` passes `p_employee_id` and uses the shared checked email-send helper.
- DONE: Team and onboarding invitation sends now use the same checked helper.
- DONE: legacy setup wizard now uses the canonical invitation RPC instead of raw `organization_invitations` inserts.
- Preserved enterprise semantics:
  - portal invitations may carry no access groups;
  - internal invitations may specify access groups;
  - missing internal groups falls back during acceptance to the default internal group.
- DONE: UI distinguishes “invitation saved but email failed” from “email sent”.
- PENDING: employee profile/sidebar pending-invitation display still needs a dedicated UI pass if not already covered by current access status.

### 5. Runtime-verify employee linking architecture — PARTIAL
- Exercise `get_linkable_users_for_employee` through the real UI/session path.
- Verify `EmployeeLinkDialog` uses only the server-side candidate RPC and does not read identity tables directly.
- Verify `link_employee_to_user` / `unlink_employee_from_user` remain the only employee `user_id` write paths and still emit lifecycle events.
- DB shape verified; authenticated runtime verification remains pending because no preview JWT is available in this sandbox.
- DONE: added DB-level enforcement so direct `employees.user_id` writes cannot bypass `link_employee_to_user`, `unlink_employee_from_user`, `accept_organization_invitation_atomic`, or `link_self_as_employee`.
- DONE: corrected invitation acceptance to avoid relying on volatile PL/pgSQL `FOUND` state after inserting/updating `user_roles`; this preserves employee linking for newly provisioned invitees.

### 6. Regression protection — DONE/PARTIAL
- Add/adjust tests for:
  - DONE: canonical invitation RPC signature only;
  - no direct `employees.user_id` mutations from app code;
  - DONE: invite send failure surfaces to the user via shared helper;
  - existing: pending invite reuse does not duplicate rows;
  - existing: employee lifecycle events are emitted for invite, accept, link, unlink, revoke;
  - DONE: DB trigger and acceptance RPC source-marker checks added to the pgTAP guard.

### 7. Final validation — PENDING USER RUNTIME RETRY
- Re-send Fredrick’s invitation once from the app session.
- Confirm:
  - still one pending invitation row;
  - `expires_at` refreshed;
  - `platform_email_logs` contains the send or a real provider rejection;
  - browser toast reflects the true outcome;
  - no recurrence of `permission_group_ids` NOT NULL or ambiguous `user_id` errors.

## Notes

- Supabase linter reported many pre-existing security-definer-view warnings after the RPC-overload migration; these were not introduced by this change.
- Current global build/typecheck still reports pre-existing missing dependency noise (`react-router-dom`, `framer-motion`, etc.), consistent with the earlier directive to ignore unrelated build noise.

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