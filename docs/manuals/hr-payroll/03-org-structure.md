# 03 · Org Structure, Contracts & Compensation

## Purpose
How the company shape is modelled and how every employee's pay terms are tracked over time.

## Org-shape tables

| Table | Purpose | Key fields |
|---|---|---|
| `departments` | Hierarchical departments | `name`, `manager_id`, `parent_department_id` |
| `job_positions` | Catalog of formal titles | `title`, `department_id`, `is_active`, `expected_headcount` |
| `work_locations` | Physical / remote work bases | `name`, `location_type ∈ {office, remote, hybrid}`, address |
| `employee_position_history` | Audit of every role/department/manager change | `prev_*` snapshots, `change_reason`, `changed_by` |

Pages: `Departments.tsx`, `JobPositions.tsx`, `WorkLocations.tsx`, `OrgChart.tsx` (visual hierarchy from `employees.manager_id`).
Hooks: `useDepartments.ts`, `useJobPositions.ts`, `useWorkLocations.ts`.

**Gotchas**
- `employees.job_position_id` replaces a legacy free-text `position` column; backfill completeness from migration `20260504` is **UNVERIFIED**.
- A self-referential `manager_id` cycle is not blocked by any constraint — keep a UI sanity check if you build a manager picker.

## Contracts (`employee_contracts`)

The contract is the legal/pay snapshot for an employee at a point in time.

**Columns**: `employee_id`, `status ∈ {new, running, expired, cancelled}`, `wage`, `housing_allowance`, `transport_allowance`, `other_allowances` (jsonb), `salary_structure_id`, `time_tracking_source ∈ {attendance, timesheets}`, `working_schedule`, `start_date`, `end_date`, `probation_end_date`, `contract_reference`, `approved_at/by`, `submitted_at/by`.

**State transitions**
```text
new ──activateContract──► running ──(date or manual)──► expired
            └────────────► cancelled
```
- The payroll engine reads `employee_contracts WHERE status='running'` to resolve wages. **No DB UNIQUE constraint** enforces a single running contract per employee — keep this invariant in the UI (Chapter 13 risk #2).

**Per-component pay**: `contract_compensation_components` (`component_code`, `label`, `amount`, `recurrence`, `taxable`, `effective_from`, `effective_to`). UI for these is not currently exposed; payroll consumption (vs the top-level `wage`/`housing_allowance`/`transport_allowance` columns) is **UNVERIFIED**.

Code: `useEmployeeContracts.ts`, `EmployeeContractsTab.tsx`, `profile/ContractsSection.tsx`.

## Compensation history (`employee_compensation_history`)

Immutable audit of every wage change. Columns: `effective_date`, `basic_salary`, `allowances_json`, `change_type`, `reason`, `source_contract_id`, `approved_at/by`, `submitted_at/by`, `currency_code`.

- Written when a contract is activated/edited, when the merit-cycle UI creates a change, or when a manual `EmployeeCompensationChangeDialog.tsx` is submitted.
- The columns hint at a draft → submitted → approved workflow, but **no approval UI is wired today** (Chapter 13 risk #7). Changes appear effective immediately.

## Performance, talent & training (the "Talent" app)

Installable separately as `talent`. Routes mount under `/hr/talent/*` via `src/apps/hr/sub/TalentRoutes.tsx` (17 pages). Key surfaces:

- **Cycles** (`CyclesPage.tsx`) — `performance_cycles` (open → collecting → calibration → closed). Advanced by edge fn `talent-cycle-tick` on a schedule; **failure stalls cycles silently** (Chapter 13 risk #9).
- **Goals & Reviews** (`ReviewDetailPage.tsx`, `MyGoals.tsx`) — `performance_goals`, `performance_reviews`, `review_*`.
- **Calibration / 9-Box** (`CalibrationPage.tsx`, `NineBoxPage.tsx`) — `calibration_sessions`, `talent_potential_ratings`.
- **Succession** — `succession_plans`, `successors`, `talent_pools`.
- **Merit** (`MeritPage.tsx`) — `merit_recommendations`. Approved increases should land in `employee_compensation_history`; the integration is **UNVERIFIED** and may bypass the governance columns.
- **Learning** — `training_courses`, `training_enrollments`, `learning_paths`, `quiz_*`. Portal mirror: `/me/learning/*`.

## HR policies (`hr_policies`)

One row per business. Configures probation, notice, leave year start, employee numbering, default onboarding/offboarding templates, retire age. Editor: `HRPoliciesPage.tsx`.

**Risk**: `employee_number_next_seq` is incremented in app code (Chapter 13 risk #3). Convert to a DB sequence before scaling.

> Full evidence: `./_research/01-hr-domain.md`.
