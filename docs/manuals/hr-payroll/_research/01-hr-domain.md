# Research: HR / Employee Lifecycle Domain

Source: sub-agent investigation `sub_2kgk7kft`. Verified read-only against current codebase. Input for chapters `02-hr-employee-lifecycle.md` and `03-org-structure.md`.

## 1. Employee CRUD

### Tables
- `employees`: `id`, `organization_id`, `business_id`, `branch_id`, `first_name`, `last_name`, `email`, `hire_date`, `termination_date`, `is_active`, `lifecycle_status` (enum), `user_id` (nullable FK → `auth.users`), `user_access_status`, `job_position_id`, `work_location_id`, `department_id`, `manager_id`, `employee_number`, `employment_type`, `bank_*`, `statutory_country_code`.
- `employee_position_history`: `employee_id`, `job_position_id`, `department_id`, `manager_id`, `branch_id`, `effective_from`, `prev_*`, `change_reason`, `changed_by`.
- `employments`: `employee_id`, `organization_id`, `business_id`, `branch_id`, `start_date`, `end_date`, `status ∈ {active,on_leave,suspended,terminated}`, `termination_type`, `termination_reason`, `is_primary`.

### Lifecycle status enum
`draft → active → on_leave / notice / suspended → exited → archived`.

### Code paths
- `src/pages/Employees.tsx` — directory with infinite scroll.
- `src/hooks/hr/useEmployeesPaged.ts` (1-138) — cursor-paginated RPC `list_employees_paged`.
- `src/hooks/useEmployees.ts` — full-list hook used by 22+ consumers.
- `src/components/employees/EmployeeFormDialog.tsx` (1-549) — create/edit; writes `job_position_id`, `work_location_id`.
- `src/components/employees/directory/BulkActionBar.tsx` — bulk invite/assign/deactivate.
- `src/hooks/hr/useEmployments.ts` (1-139) — `employments` CRUD, `terminate()`, `rehire()`.
- `src/components/hr/EmployeeTerminationDialog.tsx` — termination UI; reads blockers from `useExitClearance`.
- `src/pages/hr/EmployeeProfile.tsx` — profile tabs.

### State transitions
```
HR creates employee  (lifecycle_status='draft', is_active=false, user_access_status='none')
  → activate employment row (employments.status='active')
     → trigger sync_employee_from_employments → employees.is_active=true, lifecycle_status='active'
  → terminate (employments.status='terminated', end_date set)
     → trigger → employees.is_active=false, termination_date set, lifecycle_status='exited'
  → rehire → new employments row, status='active' again
```

### RLS
Org-scoped. Directory uses SECURITY INVOKER `list_employees_paged`. Branch managers filtered via `useHrScope` + dev-time `assertHrScope` (not a security boundary). Portal users use `v_employees_safe`.

### Risks
- Denormalized `employees` columns (`is_active`, `hire_date`, `employment_type`) still writable from FE, bypassing `sync_employee_from_employments` (Wave 2C target).
- `employee_position_history` writer (trigger vs client) UNVERIFIED.
- `lifecycle_status` transitions not DB-enforced (no CHECK/trigger guard).

## 2. Invitation & Portal Activation
(See research/06-employee-portal.md for full detail.)

Tables: `organization_invitations`, `employees.user_id`, `employees.user_access_status`, `employee_credentials` (kiosk PIN only — name is misleading), `onboarding_attempts` (diagnostic log).

Code: `EmployeeInviteDialog.tsx:69-147`, `useInvitation.ts`, `OnboardingSetup.tsx`, `EmployeeLinkDialog.tsx` (`link_employee_to_user` RPC), `SetKioskPinDialog.tsx`, `OnboardingIssues.tsx` (`hr_list_failed_onboarding_attempts`).

Edge fns: `send-invitation-email`, `validate-invitation`, `accept-invitation`.

State: `user_access_status: none → invited → active`.

Risks:
- `admin.createUser` runs **outside** the SQL transaction — crash between Deno auth call and RPC leaves orphaned auth user with no org role.
- Auto-link is `ilike(email)` — typos in `employees.email` silently skip linking; now surfaces in `onboarding_attempts`.
- `employee_credentials` naming is misleading; it only stores kiosk PIN, not portal password.
- Self-invite guard is client-side only; server enforcement UNVERIFIED.

## 3. Onboarding

Tables: `employee_onboarding`, `employee_onboarding_items`, `onboarding_templates`, `onboarding_template_items`, `onboarding_attempts`.

Code: `src/hooks/hr/useOnboardingTemplate.ts`, `EmployeeOnboardingTab.tsx`, `OnboardingTemplatesPage.tsx`, `OnboardingTemplateEditor.tsx`, `OnboardingIssues.tsx`.

DB trigger `auto_create_default_onboarding` seeds `employee_onboarding(_items)` from `pack_requirements` on employee INSERT.

State: `pending → in_progress → completed`; item completion via `completed_at` timestamp.

Risks:
- Template item reorder uses two sequential UPDATEs (non-atomic).
- No UI for HR to retry/remediate failed onboarding attempts.

## 4. Contracts

Tables:
- `employee_contracts`: `employee_id`, `organization_id`, `business_id`, `branch_id`, `status ∈ {new,running,expired,cancelled}`, `wage`, `housing_allowance`, `transport_allowance`, `other_allowances` (jsonb), `salary_structure_id`, `time_tracking_source`, `working_schedule`, `start_date`, `end_date`, `probation_end_date`, `contract_reference`, `approved_at/by`, `submitted_at/by`.
- `contract_compensation_components`: `contract_id`, `component_code`, `label`, `amount`, `recurrence`, `taxable`, `effective_from`, `effective_to`.
- `employee_compensation_history`: `employee_id`, `effective_date`, `basic_salary`, `allowances_json`, `change_type`, `reason`, `source_contract_id`, `approved_at/by`, `submitted_at/by`, `currency_code`.

Code: `useEmployeeContracts.ts`, `EmployeeContractsTab.tsx`, `EmployeeCompensationHistoryTab.tsx`, `EmployeeCompensationChangeDialog.tsx`, `profile/ContractsSection.tsx`.

State: `new → running` (activateContract) `→ expired/cancelled`. Only one `running` per employee expected.

Risks:
- No DB UNIQUE constraint blocking concurrent `running` contracts.
- `contract_compensation_components` CRUD not exposed in UI; payroll consumption UNVERIFIED.
- Compensation history has `submitted_at/by` + `approved_at/by` but no approval UI exists.

## 5. Documents

Tables:
- `employee_documents`: `employee_id`, `document_type`, `name`, `file_path`, `file_name`, `file_size`, `mime_type`, `uploaded_by`, `expiry_date`, `is_verified`, `verified_by`, `verified_at`, `acknowledged_at`, `acknowledged_by`.
- `hr_document_categories`: `business_id`, `code` (unique with business_id), `name`, `is_required_for_onboarding`, `retention_days`, `sort_order`, `is_active`.

Code: `useEmployeeDocuments.ts`, `EmployeeDocumentsTab.tsx`, `useMyDocuments.ts`, `DocumentCategoriesPage.tsx`.

Edge fns: `generate-document`, `send-document-email`.

Risks:
- `useEmployeeDocuments.ts` queries by `business_id` but `EmployeeDocument` interface lacks the field.
- `hr_document_categories` is config-only; **not FK-linked** to `employee_documents.document_type`.
- `retention_days` never enforced (no scheduled job).

## 6. Departments / Job Positions / Work Locations

Tables: `departments`, `job_positions`, `work_locations` (all org+business scoped, soft-delete via `is_active`).

Code: `useDepartments.ts`, `useJobPositions.ts`, `useWorkLocations.ts`, `JobPositions.tsx`, `WorkLocations.tsx`, `Departments.tsx`, `OrgChart.tsx`.

Risks: backfill completeness of `employees.job_position_id` UNVERIFIED; circular `manager_id` references not DB-blocked.

## 7. Position History
`employee_position_history` — append-only. Writer (trigger vs client) UNVERIFIED. `changed_by` is nullable.

## 8. Performance & Competencies (Talent app)

Tables: `performance_cycles`, `performance_goals`, `performance_reviews`, `employee_competencies`, `competencies`, `training_enrollments`, etc.

Code: `usePerformance.ts` (407 LOC), `useTalent.ts` (497 LOC), `src/apps/hr/sub/TalentRoutes.tsx` (17 pages), `CyclesPage.tsx`, `CalibrationPage.tsx`, `NineBoxPage.tsx`, `CompetenciesPage.tsx`, `ReviewDetailPage.tsx`, `MeritPage.tsx`.

Edge fn: `talent-cycle-tick` (scheduled — advances cycle states).

Risks:
- `talent-cycle-tick` failure stalls cycles silently.
- Merit page compensation changes may bypass `submitted_at/approved_at` governance.

## 9. Training
Table `training_enrollments`. Pages under `LearningPage.tsx`, `LearningPathsPage.tsx`, `LearningReportsPage.tsx`, `QuizAuthorPage.tsx`; portal `MyLearningPathsPage.tsx`.

## 10. HR Policies (per-business config)
`hr_policies` (unique on `business_id`): `probation_period_months`, `notice_period_days`, `leave_year_start_month`, `employee_number_format`, `employee_number_next_seq`, `default_onboarding_template_id`, `default_offboarding_template_id`, `retire_age`.

Code: `useHRPolicies.ts`, `HRPoliciesPage.tsx`.

Risks:
- `employee_number_next_seq` incremented in app code (race condition possible).
- FK `default_onboarding_template_id` cascade behavior UNVERIFIED.

## HR-relevant edge function inventory
`accept-invitation`, `send-invitation-email`, `validate-invitation`, `talent-cycle-tick`, `generate-document`, `send-document-email`, `generate-payslip-pdf`, `generate-payroll-document`, `check-missing-timesheets`, `pin-login`, `biometric-ingest`, `attendance-missed-checkout`, `check-leave-expiry`.

## Cross-cutting Risks Summary

| # | Risk | Sev |
|---|---|---|
| 1 | `accept-invitation`: `admin.createUser` outside SQL transaction | HIGH |
| 2 | No DB constraint enforcing single `running` contract per employee | MED |
| 3 | `employee_number_next_seq` not a DB sequence (race condition) | MED |
| 4 | `hr_document_categories` not FK-linked to `employee_documents.document_type` | LOW/MED |
| 5 | `lifecycle_status` transitions not DB-enforced | MED |
| 6 | Onboarding template reorder non-atomic | LOW |
| 7 | Compensation approval workflow UI missing | MED |
| 8 | Document retention never enforced | LOW |
| 9 | `talent-cycle-tick` failure stalls cycles silently | MED |
| 10 | `employee_position_history` writer authority unclear | LOW |
