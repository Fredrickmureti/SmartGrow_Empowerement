---
name: Employee module — completion status
description: Status of the Employee architecture audit/lifecycle reconstruction plan. All plan items closed except pre-existing schema-drift TS noise (user directive: ignore).
type: feature
---

# Employee module — plan completion

## Phase 1 — Write-path holes (DONE)
- `useEmployees.createEmployee` now delegates to `create_employee_with_identifiers` RPC (atomic identifier insert, server-side employee_number).
- `EmployeeFormDialog` calls `discard_employee_draft` on cancel via `onDiscardDraft` prop wired in `EmployeeNewPage`.

## Phase 2 — Canonical read model (DONE)
All 24 operational SELECT call sites swapped from `.from("employees")` to `.from("v_employees_canonical")`:
hooks: useGovernedEntityOptions, useTalentAnalytics, useTalent (2), useReviews (2), useJobPositions, useBenefitPlans, useLeaveRequests (3), useLeaveAccruals, useMyShiftToday, useEmployeeProfile (manager), useDevelopmentPlans (3), useCurrentEmployee, useCompetencyFramework, talent/notifications.
components/pages: MyWeekStrip, EmployeeContractsTab, MyTeamTalent, MyTeamPage (2), MyTeamLearningPage, MyQuizPlayerPage, MyLearningPathsPage, ProjectTimesheets, TaskDetail.
`is_active` filters on canonical view swapped to `is_operationally_active`.

Write-back call sites (UPDATE/DELETE/INSERT) intentionally left on base `employees` and recorded in the arch-test allowlist:
EmployeeManagerDialog, EmployeeInviteDialog, EmployeeHRSettings, EmployeeAvatarUpload, useEmployeeProfile (update), Employees.tsx (bulk update), useEmployees.ts (update/delete/automation snapshot), attendance.ingest.ts (server-side admin), resolveEmployeeNaturalKeys.ts (server-side natural-key join).

## Phase 3 — Identity & uniqueness (DONE)
pgTAP guard: `supabase/tests/employees_identity_uniqueness_test.sql`
Asserts: work_email partial unique (drafts exempt), personal email NOT unique, user_id partial unique (org+business, drafts exempt), national_id unique per org, lifecycle_status→is_active trigger present, canonical view projects lifecycle helper cols.

## Phase 4 — Build-noise triage (DEFERRED per user)
User directive `================IGNORE CURRENT BUILD NOISES==========` — ~30 pre-existing schema-drift TS errors (governance loaders, BusinessSagaMount goods_receipt_items, useExecutiveStats contacts.company, useAttendance deep inference, InvoiceDetailDialog invoice_id, useProductDetailData branch_id, etc.) remain. NOT introduced by this audit; needs dedicated sweep.

## Phase 5 — Lint + arch guard (DONE)
- ESLint rule `eslint-rules/no-direct-employees-read.js` (allowlist-driven).
- Arch test `src/test/architecture/employees-reads-via-canonical.test.ts` — flags `.from("employees").select(...)` outside allowlist.

## Out of scope (as planned)
Payroll/Attendance/Time Off internal rewrites beyond their employees reads; visual/UI redesign.
