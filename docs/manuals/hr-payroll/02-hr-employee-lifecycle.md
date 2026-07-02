# 02 · HR Employee Lifecycle

## Purpose
How a person enters, moves through, and exits the system as an "employee" record — independent of whether they ever log in to the portal.

## Primary tables
- **`employees`** — master record. Key columns: `id`, `organization_id`, `business_id`, `branch_id`, `email`, `hire_date`, `termination_date`, `is_active`, `lifecycle_status` (enum), `user_id` (nullable FK → `auth.users`), `user_access_status`, `job_position_id`, `work_location_id`, `department_id`, `manager_id`, `employee_number`, `employment_type`, `bank_*`, `statutory_country_code`.
- **`employments`** — the actual employment relationship. One row per stint at the company. Columns: `start_date`, `end_date`, `status ∈ {active, on_leave, suspended, terminated}`, `termination_type`, `termination_reason`, `is_primary`.
- **`employee_position_history`** — append-only audit of every position/department/manager change.
- **`onboarding_attempts`** — diagnostic log written by the invitation-accept flow.

## Lifecycle states
```text
draft → active → on_leave / notice / suspended → exited → archived
```
The `lifecycle_status` enum is set by the application; **no DB trigger or CHECK constraint currently enforces valid transitions** (see Chapter 13 risk #5).

## Day-in-the-life flow

### Create
- HR opens `src/pages/Employees.tsx` → `EmployeeFormDialog.tsx` (1-549).
- A new `employees` row is INSERTED with `lifecycle_status='draft'`, `is_active=false`, `user_access_status='none'`.
- `employee_number` is allocated client-side using `hr_policies.employee_number_format` + `employee_number_next_seq` — **note this is incremented in app code, not by a DB sequence; concurrent creates can collide** (Chapter 13 risk #3).

### Activate employment
- An `employments` row is INSERTED with `status='active'` (via `useEmployments.ts:1-139`).
- DB trigger `sync_employee_from_employments` denormalizes `employees.is_active=true`, `employees.hire_date`, and stamps `lifecycle_status='active'`.

### Invite to portal (optional)
- HR clicks **Invite** on the directory → `EmployeeInviteDialog.tsx:69-147`.
- App calls RPC `upsert_organization_invitation` (writes `organization_invitations`) → edge fn `send-invitation-email`.
- `employees.user_access_status` flips `none → invited`.
- Full invitation/accept flow lives in **Chapter 11**.

### Transfer / promote
- `EmployeeTransferDialog.tsx` updates the row (department / position / manager / branch).
- A new `employee_position_history` row records the change (writer authority — trigger vs client — is **UNVERIFIED**).

### Terminate
- HR opens `EmployeeTerminationDialog.tsx`.
- Reads **blockers** from `useExitClearance` (open items in `employee_exit_clearance` + `_items`).
- `employments.status='terminated'`, `end_date` set; trigger denormalizes `employees.is_active=false`, `termination_date`, `lifecycle_status='exited'`.

### Rehire
- A fresh `employments` row is INSERTED with `status='active'`. The original row is preserved for audit.

### Archive
- Cosmetic flip to `lifecycle_status='archived'`; no DB cleanup occurs.

## State-transition diagram
```text
+---------+ create  +--------+  invite   +----------+  accept   +---------+
|  draft  |───────► | active |──────────►| invited  |──────────►| active+ |
+---------+         +--------+           +----------+           | portal  |
                       │                                        +─────────+
                       │ leave/suspend                              │
                       ▼                                            │
                  +----------+                                      │
                  | on_leave |                                      │
                  +----------+                                      │
                       │ return                                      │
                       ▼                                            │
                  +--------+                                        │
                  | active |                                        │
                  +--------+                                        │
                       │ terminate (blocked if exit clearance open) │
                       ▼                                            │
                  +--------+   archive   +----------+               │
                  | exited |────────────►| archived |◄──────────────┘
                  +--------+             +----------+
```

## Documents
- `employee_documents` stores files (path in Supabase Storage, `documents` bucket).
- `hr_document_categories` defines codes but is **not FK-linked** to `employee_documents.document_type` — the two systems run side by side (Chapter 13 risk #4).
- Employee Self-Service exposes own documents via `/me/documents` (RLS scoped); acknowledgement is recorded via RPC `acknowledge_employee_document`.
- `retention_days` exists on categories but is **not enforced** by any scheduled job (Chapter 13 risk #8).

## Onboarding
- DB trigger `auto_create_default_onboarding` fires on employee INSERT and seeds `employee_onboarding(_items)` rows from the active `onboarding_templates` for the business, filtered/augmented by `pack_requirements`.
- Editor: `OnboardingTemplateEditor.tsx`; template list: `OnboardingTemplatesPage.tsx`; item completion in `EmployeeOnboardingTab.tsx`; failed invitation linkages surface in `OnboardingIssues.tsx` via RPC `hr_list_failed_onboarding_attempts`.

## RLS posture
- Org-scoped reads via SECURITY INVOKER `list_employees_paged` RPC (`useEmployeesPaged.ts:1-138`).
- Branch managers are filtered client-side via `useHrScope` + dev-time `assertHrScope` — **not** a security boundary.
- Portal users use the column-masked `v_employees_safe` view; raw PII columns on `employees` are revoked from `authenticated` (Chapter 11).

## Edge cases
- Two `running` contracts per employee are not prevented at DB level (Chapter 4 / Chapter 13 risk #2).
- Auto-link in `accept-invitation` uses `ilike(email)` — typos in `employees.email` silently skip the link (a row appears in `onboarding_attempts` with `status='failed'`).
- A circular `manager_id` chain is not blocked by any constraint.

## Where to look in code
- Pages: `src/pages/Employees.tsx`, `src/pages/hr/EmployeeProfile.tsx`, `src/pages/hr/OnboardingIssues.tsx`.
- Components: `src/components/employees/EmployeeFormDialog.tsx`, `EmployeeInviteDialog.tsx`, `EmployeeLinkDialog.tsx`, `EmployeeTransferDialog.tsx`, `EmployeeTerminationDialog.tsx`, `EmployeeOnboardingTab.tsx`, `EmployeeDocumentsTab.tsx`, `EmployeeHistoryTimeline.tsx`.
- Hooks: `useEmployees.ts`, `useEmployeesPaged.ts`, `useEmployments.ts`, `useEmployeeDocuments.ts`, `useOnboardingTemplate.ts`, `useExitClearance`.

> Full evidence: `./_research/01-hr-domain.md`.
