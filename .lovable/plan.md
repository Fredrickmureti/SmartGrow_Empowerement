
# ESS Identity & Profile Architecture — Audit + Redesign Plan

Scope: architectural, not cosmetic. Fix ownership boundaries, routing, and information architecture across the `/me/*` portal. No changes to HR write paths, payroll, or auth backends beyond what's required to enforce ownership.

## 1. Root causes of the current symptoms

| Symptom | Root cause |
|---|---|
| `/me/profile` → immediately back to `/me` | `src/pages/hr/MyProfile.tsx` redirects the portal user to `/hr/employees/:id`. `/hr/*` is admin-app space; the portal guard (`InternalOnlyRoute` / `PermissionProtectedRoute`) bounces portal users back to `/me`. Two shells fighting each other. |
| Editable "Account Profile" inside `/me/settings` | `MySettings` embeds `UserProfilePage` (the workspace-user profile editor). It edits the **auth/profile row**, not the HR employee — but presents itself as "your profile", so users assume it updates HR. Two identities blurred into one form. |
| Notifications link exits the portal shell | `/me/settings` links to `/notifications`, which is rendered by the business shell — no `MePortalLayout` wrapper. |
| Password disabled ("contact admin") | Placeholder. No decision has been made about whether this project uses Supabase auth self-service, SSO, or admin-issued creds. |
| Profile ownership ambiguity | No field-level classification exists. The HR record, the `profiles` auth row, and `auth.users` are all reachable from portal UI without an ownership model. |

## 2. Identity lifecycle — canonical model

Three separate records, three owners:

```text
auth.users            (Identity)          — email, password, MFA, sessions
  └─ profiles         (User Account)      — display name, avatar, phone-for-login, UI prefs
       └─ employees   (HR Record)         — legal name, national ID, employment, comp, bank
```

Lifecycle events (already largely modeled in DB — see `employee_lifecycle_events`, `organization_invitations.employee_id`, `user_access_status` trigger):

1. HR creates employee (draft → active)
2. HR issues invitation (`user_invited`)
3. Invitee accepts (`user_invitation_accepted`, `user_linked`) — auth.users + profiles row created, employee.user_id set
4. Portal access granted; ESS surfaces filter by `employee.user_id = auth.uid()`
5. Field edits route to the correct owner (see §4)
6. HR terminates employee (`lifecycle_status = terminated`) → portal access revoked, auth.users retained for audit
7. HR unlinks (`user_unlinked`) → auth.users optionally disabled

This lifecycle is already correct in the DB. The **UI** does not respect it.

## 3. Field ownership matrix (the source of truth)

| Field | Owner | Employee can… | Approval | Notifies |
|---|---|---|---|---|
| Legal first/last name | HR | Request change | HR approves | Payroll, statutory, ID docs |
| Preferred name / display name | User Account | Edit freely | — | — |
| Work email | HR + Identity | Read-only | Admin only | Identity, invites |
| Personal email | Employee-managed | Edit | — | HR notified |
| Phone (personal) | Employee-managed | Edit | — | HR notified (emergency) |
| Phone (work) | HR | Read-only | HR | — |
| Home address | Employee-managed | Edit | — | HR notified (statutory) |
| Emergency contact | Employee-managed | Edit | — | HR notified |
| National ID / tax IDs | HR | Read-only (masked) | HR only | Payroll |
| Bank account (payroll) | Employee-managed, HR-gated | Request change | HR approves before next payroll | Payroll |
| Avatar | User Account | Edit | — | — |
| Date of birth | HR | Read-only | HR | — |
| Marital status / dependents | Employee-managed | Edit | — | HR notified (tax) |
| Job title, department, manager, salary | HR | Read-only | — | — |
| Password / MFA | Identity | Self-service (if enabled) | — | Security log |
| UI preferences (theme, locale, notif channels) | User Account | Edit | — | — |

"Request change" fields go through a lightweight change-request queue (new table `employee_profile_change_requests`) that HR approves; approval applies the diff to `employees` and emits a lifecycle event.

## 4. Route & shell architecture

Every URL starting with `/me/` MUST render inside `MePortalLayout`. No portal link may point into `/hr/*`, `/settings/*`, or `/notifications` directly.

New/changed routes (all under `MeApp.tsx`, wrapped by `SelfServiceProvider` + `MePortalLayout`):

```text
/me                     Home (unchanged)
/me/profile             NEW ESS profile page (read-only HR view + editable personal section)
  /me/profile/personal    Editable personal contact block
  /me/profile/emergency   Emergency contacts
  /me/profile/bank        Bank details (change-request flow)
  /me/profile/documents   Employee documents (moved from /me/documents header link)
/me/account             NEW — Identity & User Account surface
  /me/account/security    Password, MFA, sessions, login history
  /me/account/preferences Theme, locale, notification channels
/me/notifications       NEW — inbox rendered inside portal shell (reuses existing NotificationsPage body)
/me/requests            NEW — my open change requests (profile edits, leave, etc.)
```

Removed:
- `MyProfile.tsx` redirect to `/hr/employees/:id` (portal users must never enter `/hr/*`)
- `/me/settings` embedded `UserProfilePage` (split into `/me/profile/personal` + `/me/account`)
- Portal link to `/notifications` (rewritten to `/me/notifications`)

`MySettings.tsx` becomes a thin index page linking to `/me/profile`, `/me/account/security`, `/me/account/preferences`. Password tile becomes active when Supabase email/password auth is on for the org; otherwise it links to SSO help (decision: default ON — Supabase email/password self-service via `resetPasswordForEmail`, since this project already uses Supabase auth).

## 5. New ESS Profile page (`/me/profile`)

Three-section layout, ownership visible in the UI:

1. **HR record** (read-only card, badge: "Managed by HR")
   Name (legal), employee number, job title, department, manager, employment status, start date, work email, work phone.
   Footer: "Something wrong? Request a correction" → opens change-request dialog scoped to HR-owned fields.

2. **Personal details** (editable, badge: "You manage this")
   Preferred name, personal email, personal phone, home address, DOB display (read-only), marital status, dependents.
   Saves to `employees` via a new RPC `update_own_employee_personal(...)` that whitelists ONLY employee-managed columns and emits a lifecycle event + optional HR notification.

3. **Sensitive** (change-request flow, badge: "HR approval required")
   Legal name, bank account, tax identifiers (masked). Submit → row in `employee_profile_change_requests`, HR reviews in `/hr/employees/:id` → approve applies diff.

Avatar lives on `/me/account` (User Account ownership), not on the HR profile card, so it's clear the avatar is a portal-user asset, not an HR record.

## 6. Backend changes

- **New table** `employee_profile_change_requests` (id, employee_id, requested_by, field_key, old_value, new_value, status, reviewed_by, reviewed_at, created_at). RLS: employee can insert/select own; HR admins select/update org rows. `GRANT` block per project convention.
- **New RPC** `public.update_own_employee_personal(patch jsonb)` — whitelists employee-managed columns, updates `employees` for `WHERE user_id = auth.uid()`, emits lifecycle event, notifies HR channel.
- **New RPC** `public.submit_profile_change_request(field_key text, new_value jsonb)` and `approve_profile_change_request(id uuid)`.
- **New view** `v_my_employee_profile` — canonical read for the portal profile page, projecting HR-owned + employee-managed + masked-sensitive fields; grants SELECT to `authenticated`, RLS: `employee.user_id = auth.uid()`.
- Password reset: reuse Supabase `resetPasswordForEmail` + existing `/reset-password` flow.

## 7. Portal navigation redesign (inside `MePortalLayout`)

Top-level items become:

```text
Home · Time off · Timesheets · Attendance · Payslips · Documents · Learning · Talent · Notifications · Profile
```

Bottom / user menu: **Profile · Account · Sign out** (Account = identity/security/preferences).

Every `/me/*` page renders inside the same shell — no exits to `/hr` or `/notifications`. Breadcrumbs added on nested pages (`Profile / Personal`, `Account / Security`). Visual continuity: same header, same nav rail, same width, same page-title component.

## 8. What we are explicitly NOT doing

- No changes to HR admin write paths (`/hr/employees/*`).
- No changes to payroll, leave, timesheets, attendance business logic.
- No renaming of DB columns; only additive tables/RPCs/views.
- No new auth provider; Supabase email/password stays. SSO remains a future toggle.

## Technical section

- Files added: `src/pages/me/MyProfilePage.tsx`, `MyProfilePersonal.tsx`, `MyProfileEmergency.tsx`, `MyProfileBank.tsx`, `MyAccount.tsx`, `MyAccountSecurity.tsx`, `MyAccountPreferences.tsx`, `MyNotifications.tsx`, `MyRequests.tsx`. Change-request dialog under `src/components/me/profile/`.
- Files removed/rewritten: `src/pages/hr/MyProfile.tsx` (delete redirect), `src/pages/me/MySettings.tsx` (thin index), `src/apps/me/MeApp.tsx` (new routes), `src/components/me/MePortalLayout.tsx` (nav update), portal `Link to="/notifications"` rewritten to `/me/notifications`.
- Migrations: `employee_profile_change_requests` table + GRANTs + RLS + policies; `v_my_employee_profile` view; RPCs `update_own_employee_personal`, `submit_profile_change_request`, `approve_profile_change_request`. All emit `employee_lifecycle_events`.
- pgTAP guard: new test asserting the RPC whitelists, the view masks sensitive columns, and RLS scopes to `auth.uid()`.
- ESLint rule: extend existing `no-hand-rolled-me-header` family with `no-portal-link-outside-me` to block `/me/*` pages linking into `/hr/*`, `/settings/*`, or `/notifications`.
- Auth: `/me/account/security` uses `supabase.auth.updateUser({ password })` and `resetPasswordForEmail`; MFA left as a follow-up toggle.

## Open questions before build

1. Approval workflow: single-step (HR admin) or two-step (manager → HR)? Default: single-step HR.
2. Should bank-account changes be blocked during an open payroll run? Default: yes, reject with reason.
3. Password self-service: enable now (Supabase email/password) or leave disabled pending SSO decision? Default: enable now.
