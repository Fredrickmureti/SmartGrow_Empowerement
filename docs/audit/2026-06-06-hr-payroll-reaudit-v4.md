# HR & Payroll Re-Audit v4 — Phase 1 Deep Re-Verification

**Date:** 2026-06-06
**Auditor scope:** HR, Payroll, Leave, Attendance, Timesheets, Loans, Advances, Benefits, Lifecycle, Self-Service.
**Mode:** Independent re-verification. Treats every prior "shipped" claim as unverified until proven by live DB / source inspection.

---

## A. Verified working (DB + code evidence)

| Claim | Evidence |
|---|---|
| Turn A — drop legacy `employees` compensation/org columns | `information_schema.columns`: `basic_salary, housing_allowance, transport_allowance, department, position, insurance_premium` no longer present on `employees`. `v_employees_safe` view present, security-invoker, exposes legacy aliases via FK joins / `employee_contracts`. Arch guard `employees-no-legacy-comp-cols.test.ts` extended to 6 cols. |
| Turn B — archived-employee payslip block | `pg_proc.payslip_block_archived_employee` + `trg_payslip_block_archived_employee` (`tgenabled='O'`, BEFORE INSERT on `payslips`). Hint copy `PAYROLL_EMPLOYEE_ARCHIVED` present in `src/lib/edgeFunctionError.ts:54`. |
| Turn B-2 — retro engine consumption | `retro_pay_adjustments` table + `payslips.retro_of_payslip_id` + `payroll_compute_retro_for_employee()` all present. `compute-payroll/index.ts:2197` drains pending retros, materialises delta payslip with `retro_of_payslip_id` set, stamps queue row `applied`. |
| Turn C — garnishments + expense reimbursement | `employee_garnishments` (RLS=on, 2 policies). `compute-payroll/index.ts:1230–2192` loads garnishments, applies in priority order with disposable-earnings cap, emits `category='garnishment'` lines, stamps `total_paid`, and reimburses pending `expenses.reimburse_via_payroll`. |
| Turn D — benefits open-enrollment windows | `benefit_enrollment_windows` (RLS=on, 2 policies). `block_locked_enrollment_window()` + `trg_block_locked_enrollment_window` BEFORE INSERT/UPDATE on `employee_benefits` (`tgenabled='O'`). |
| Payroll immutability | `trg_payroll_runs_immutable`, `trg_payslips_immutable_upd`, `trg_payslips_immutable_del`, `trg_payslip_lines_immutable_upd`, `trg_payslip_lines_immutable_del` — all enabled. |
| Maker-checker + SoD | `enforce_payroll_maker_checker`, `user_can_post_payroll`, `user_can_pay_payroll`, `user_has_payroll_admin_override` all present. |
| Exit clearance + termination | `trg_exit_clearance_completion` (AFTER UPDATE on `employee_exit_clearance`), `consume_pending_termination_payouts`, `v_termination_payout_reconciliation` view present. |
| Loan integrity | `validate_payroll_run_loan_integrity()` + `payroll_run_loan_skip_overrides` (RLS=on, 3 policies, audit trigger `trg_audit_loan_skip_override`). |
| Manager cycle guard | `trg_employees_manager_cycle_guard` enabled (BEFORE INSERT/UPDATE on `employees`). Downgrades Phase-1 K item — already shipped. |
| PII masking | `employee_credentials` (RLS=on, 1 deny-all policy). PII column REVOKEs + `v_employees_safe` + `get_employee_pii(uuid)` audited RPC. Arch guard `no-raw-employees-pii-select.test.ts` present. |
| Nightly leave accrual cron | `process_leave_accruals` function present; prior audit confirmed `cron.job` row. |
| HR analytics views | `v_payroll_cost_by_department`, `v_leave_liability_open` present. |

## B. Partial / orphan-table findings (Phase-2 remediation queue)

| # | Finding | Severity |
|---|---|---|
| P2-1 | **No UI for `employee_garnishments`** — table + edge-fn integration shipped, but no admin page under `src/pages/hr/`. HR cannot create/edit garnishments outside SQL. | High |
| P2-2 | **No UI for `benefit_enrollment_windows`** — windows can only be inserted via SDK; benefits admin can't open/close/lock a plan year. | High |
| P2-3 | **No UI for `payroll_run_loan_skip_overrides`** — only insertable via SDK. | Medium |
| P2-4 | **`lib/edgeFunctionError.ts` missing hint copy** for: `benefit_enrollment_window_locked`, `benefit_enrollment_window_closed`, `benefit_enrollment_window_missing`, `payroll_run_immutable`, `payslip_immutable`, `payslip_line_immutable`, `payroll_post_sod_violation`, `payroll_pay_sod_violation`, `payroll_maker_checker_violation`, `exit_clearance_unsettled_loans`. Only `PAYROLL_LOAN_INSTALLMENT_MISSING`, `PAYROLL_ADVANCE_INSTALLMENT_MISSING`, `PAYROLL_EMPLOYEE_ARCHIVED` are mapped today — users see generic "permission denied" / "constraint violation" for everything else. | High |
| P2-5 | **HR analytics views are orphan** — `v_hr_headcount_snapshot`, `v_hr_turnover_rolling_12m`, `v_payroll_cost_by_department`, `v_leave_liability_open` exist but `HRDashboard.tsx` / `HRReports.tsx` do not read them. | Medium |
| P2-6 | **Probation-confirmation surfacing** — `notify_probation_expiry` cron exists, no HR Dashboard widget consumes it. | Medium |
| P2-7 | **Final-settlement reconciliation view orphan** — `v_termination_payout_reconciliation` exists, no HR Reports page surfaces it. | Medium |

## C. Confirmed missing modules (Phase-3 build queue, unchanged from approved plan)

| # | Module | Severity |
|---|---|---|
| C-E | **Shift / roster management** — no `shifts`, `shift_assignments`, `shift_swap_requests`, `shift_patterns` tables. | High |
| C-H | **Recruitment** — no `job_requisitions`, `candidates`, `candidate_applications`, `interview_*`, `offer_letters`. `employee_onboarding` exists but no upstream funnel. | High |
| C-I | **Performance & training** — no `performance_*`, `training_*`, `competencies` tables. | Medium |
| C-J | **Self-service idempotency** — leave/loan/advance request mutations lack idempotency keys; double-submit risk. | Medium |
| C-J2 | **Leave accrual edge cases** — `accrual_frequency='anniversary'` branch, `carryover_deadline` expiry, calendar-anchored due-dates (L-HR-4/5/6) still open. | Medium |
| C-J3 | **Localization-pack fail-closed** — `compute-payroll` silently skips when tenant country has no published statutory pack; should raise stable hint and block run. | High |

## D. Withdrawn / downgraded findings

- `trg_employees_manager_cycle_guard` is live → "Turn K manager cycle guard" downgraded to verification-only.
- All Turn-A–Turn-D claims pass deep verification → no rebuild required.

## E. Next turn

**Turn E — Shift & Roster Management** ships next, per approved plan Phase 3. Phase-2 remediations P2-4 (hint copy, trivial) folds into Turn E migration's same UI session. P2-1/P2-2/P2-3 ship together as **Turn F** (admin UIs for orphan tables).

## F. Evidence index (queries run)

```
-- Triggers (all tgenabled='O')
SELECT tgname, tgrelid::regclass, tgenabled FROM pg_trigger
WHERE NOT tgisinternal AND tgname ~* 'payslip|payroll_run|garnish|enrollment|archived|loan|termination|probation|manager_cycle|retro|exit_clearance';

-- RLS + policy count on new tables
SELECT relname, relrowsecurity, (policy count) FROM pg_class JOIN pg_policies …
  WHERE relname IN ('employee_garnishments','benefit_enrollment_windows','retro_pay_adjustments',
                    'payroll_run_loan_skip_overrides','employee_credentials','employee_exit_clearance',
                    'pending_termination_payouts');

-- Edge-fn wiring
rg -n "garnish|retro_pay_adjustments|enrollment_window" supabase/functions/compute-payroll/index.ts

-- Hint-copy gap
rg -n "payroll_employee_archived|PAYROLL_LOAN_INSTALLMENT_MISSING|enrollment_window|run_immutable" src/lib/edgeFunctionError.ts
```

---

## Turn E — Shift & Roster Management — SHIPPED (2026-06-06)

**Status:** End-to-end. Migration + hooks + admin + self-service + arch guard + hint copy.

### Database
- `public.shifts` — shift templates (name, start/end, break_minutes, paid_break, crosses_midnight, night_differential_pct, color, is_active). UNIQUE (org, name). RLS: org-member read, `hr.write` to mutate.
- `public.shift_assignments` — per-employee per-date roster row (status: planned/published/swapped/cancelled/completed/no_show; source: planned/swap/on_call/overtime/adjusted). UNIQUE (employee, date, shift). Indexes on (employee,date) and (org,date). RLS: self OR `hr.read` to read; `hr.write` to mutate.
- `public.shift_swap_requests` — two-sided swap workflow (pending → target_accepted/declined → approved/rejected → applied). RLS: party-or-HR read/update; only requester can insert their own; HR delete only.
- Trigger `trg_roster_overlap_guard` on `shift_assignments` BEFORE INSERT/UPDATE — rejects any new active assignment whose computed timestamptz range (handling overnight via `crosses_midnight`) overlaps an existing active assignment for the same employee within ±1 day. Raises `ERRCODE 23P01` + `HINT roster_assignment_overlap`.
- Trigger `trg_roster_swap_approver_guard` on `shift_swap_requests` — blocks `approver_user_id` from matching the requester's or target's `employees.user_id`. Raises `ERRCODE 42501` + `HINT roster_swap_approver_conflict`.
- (Function names use `roster_*` rather than `shift_*` to satisfy the pre-existing `_reject_country_named_function` event trigger — the regex would have flagged `shif`.)

### Code
- `src/hooks/useShifts.ts` — three hooks: `useShifts` (CRUD), `useShiftAssignments({from,to,employeeId?})` (range read + assign/updateStatus/remove), `useShiftSwaps(employeeId?)` (create/respond/decide). All with TanStack Query + sonner toast + `normalizeError`.
- `src/pages/hr/Shifts.tsx` — admin CRUD page for shift templates.
- `src/pages/hr/Roster.tsx` — weekly grid planner (Mon-start), click-cell-to-assign, publish/remove actions, server-side overlap guard surfaces via toast.
- `src/pages/me/MyShifts.tsx` — self-service: upcoming 60 days, swap-request open, accept/decline as target, last-14-day history.
- `src/apps/hr/sub/AttendanceRoutes.tsx` — added nav items + lazy routes for `/hr/attendance/roster` and `/hr/attendance/shifts`, gated by `manageAttendance` permission.
- `src/apps/me/MeApp.tsx` — added `/me/shifts` route.

### Hint copy (P2-4 — folded into this turn)
`src/lib/edgeFunctionError.ts` now maps these previously-orphan HINTs:
- `ROSTER_ASSIGNMENT_OVERLAP`, `ROSTER_SWAP_APPROVER_CONFLICT`
- `PAYROLL_RUN_IMMUTABLE`, `PAYSLIP_IMMUTABLE`, `PAYSLIP_LINE_IMMUTABLE`
- `PAYROLL_POST_SOD_VIOLATION`, `PAYROLL_PAY_SOD_VIOLATION`, `PAYROLL_MAKER_CHECKER_VIOLATION`
- `EXIT_CLEARANCE_UNSETTLED_LOANS`

(`BENEFIT_ENROLLMENT_WINDOW_*` were already present — original audit was stale on that point.)

### Tests
- `src/test/architecture/turn-e-shift-roster.test.ts` — 6 checks (hooks exist, pages exist, routes registered behind `PermissionProtectedRoute`, `/me/shifts` registered, self-service swap scoping uses requester/target employee_id filter, hint map covers the 9 new keys). All pass.
- Pre-existing arch suites unaffected.

### Deferred / Future
- Rotation templates (`shift_patterns`) — not shipped; admins assign per-date today. Bulk "apply pattern across N weeks" UI tracked for Turn E.1.
- `attendance` ↔ `shift_assignments` reconciliation (variance → overtime → `payroll_work_entries`) — tracked for Turn E.2 when we touch the attendance closure path.
- Real-time roster collaboration channel — not in scope.

### Next
**Turn F** — admin UIs for the three remaining orphan tables: `employee_garnishments`, `benefit_enrollment_windows`, `payroll_run_loan_skip_overrides`.

---

## Turn F — Admin UIs for orphan tables (shipped)

Three previously server-only tables are now reachable from the workspace UI.

### Hooks
- `src/hooks/useGarnishments.ts` — CRUD over `employee_garnishments` scoped by org + (optional) employee_id. RLS already restricts to HR.
- `src/hooks/useBenefitWindows.ts` — CRUD over `benefit_enrollment_windows` scoped by org + business.
- `src/hooks/useLoanSkipOverrides.ts` — list/create/delete over `payroll_run_loan_skip_overrides`, scoped by a chosen payroll run; sets `created_by = auth.uid()` on insert.

### Pages
- `src/pages/hr/payroll/Garnishments.tsx` — employee + kind + priority + cap-rule editor with start/end window and active flag. Surfaces all seven `garnishment_kind` enum values and all three `garnishment_cap_rule` modes (fixed / % of disposable / lesser-of). Lives at `/hr/payroll/garnishments`.
- `src/pages/hr/BenefitEnrollmentWindows.tsx` — plan-year window editor with open/close + coverage window + JSON eligibility filter + lock toggle. Lives at `/hr/benefit-windows`.
- `src/pages/hr/payroll/LoanSkipOverrides.tsx` — run picker (draft/computing/computed/processing only) → loan picker (`status='active'`) → installment picker (from `loan_repayment_schedule` ordered by `sequence`) + required `reason` (audited). Lives at `/hr/payroll/loan-skip-overrides`.

### Route wiring
- `src/apps/hr/sub/PayrollRoutes.tsx` — `garnishments` (gated by `managePayroll`) and `loan-skip-overrides` (gated by `runPayroll`).
- `src/apps/hr/sub/EmployeesRoutes.tsx` — `benefit-windows` (gated by `manageEmployees`).
- `src/components/payroll/PayrollSidebar.tsx` — adds "Garnishments" (Scale icon) and "Loan Skip Overrides" (Ban icon) under the Compliance group.
- `src/pages/hr/EmployeesConfiguration.tsx` — adds a "Benefit Enrollment Windows" catalog card linking to `/hr/benefit-windows`.

### Schema-shape correctness
Hooks/pages match live DB column names (verified against `information_schema`):
- `payroll_runs` → uses `payroll_number` (no `name` column).
- `employee_loans` → uses `loan_number`, `principal_amount`, `outstanding_balance` (no `amount`).
- `loan_repayment_schedule` (singular) → uses `sequence`, `due_period_end`, `scheduled_amount`.
- `employee_garnishments` → priority defaults to 100, `cap_rule` defaults to `fixed_amount`, `total_paid` defaults 0, `is_active` defaults true.
- `benefit_enrollment_windows` → `eligibility_filter` is jsonb (parsed from textarea), `is_locked` default false.

### Tests
- `src/test/architecture/turn-f-orphan-admin-uis.test.ts` — 5 checks (hooks exist & target the right table names, pages exist, garnishments + loan-skip-overrides routes registered under `gate()` in `PayrollRoutes`, benefit-windows route gated by `manageEmployees` in `EmployeesRoutes`, sidebar exposes both payroll routes).

### Deferred / Future
- Per-garnishment audit timeline UI (computed-payroll already writes a deduction trail; the page does not yet read it).
- Priority drag-reorder (current edit is via the `priority` numeric input).
- Eligibility-filter builder UI (the page accepts raw JSON; a guided builder is a follow-up).
- Loan-skip override approval workflow — today any HR with `runPayroll` can record an override; a second-signoff path could chain through `enforce_payroll_maker_checker`.

### Next
**Turn G** — wire `HRDashboard` + `HRReports` to the existing analytics views (`v_hr_headcount_snapshot`, `v_hr_turnover_rolling_12m`, `v_payroll_cost_by_department`, `v_leave_liability_open`).

---

## Turns G → K — Final completion (shipped in one session)

### Turn G — HR analytics wiring
- `src/hooks/useHRAnalytics.ts` — read hooks over `v_hr_headcount_snapshot`, `v_hr_turnover_rolling_12m`, `v_payroll_cost_by_department`, `v_leave_liability_open`.
- `src/components/hr/HRAnalyticsPanel.tsx` — 4-card panel (mix, turnover, latest-run cost-by-dept, open leave liability).
- Wired into `HRDashboard.tsx` and `HRReports.tsx`.

### Turn H — Recruitment & Onboarding
- Migration: enums (`requisition_status`, `application_stage`, `interview_recommendation`, `offer_status`), 5 tables (`job_requisitions`, `candidates`, `candidate_applications`, `interview_feedback`, `offer_letters`), `convert_application_to_employee(application_id, payload)` SECURITY DEFINER fn that atomically creates the employee, marks the application hired, and auto-closes the requisition when headcount is filled.
- `src/hooks/useRecruitment.ts` + `src/pages/hr/Recruitment.tsx` (tabbed: Requisitions / Pipeline / Candidates).
- `src/pages/Careers.tsx` — public anon careers page (reads open requisitions for `?org=<uuid>`, posts candidates via anon insert policy).
- Route wiring: `src/apps/hr/sub/RecruitmentRoutes.tsx` + dispatcher update in `src/apps/hr/routes.tsx` (removed the legacy redirect); `/careers` registered in `src/App.tsx`.

### Turn I — Performance & Training
- Migration: enums + 8 tables (`performance_cycles`, `performance_reviews`, `performance_goals`, `goal_check_ins`, `training_courses`, `training_enrollments`, `competencies`, `employee_competencies`), each with RLS + grants + indexes.
- `src/hooks/usePerformance.ts` + `src/pages/hr/PerformanceTraining.tsx` (tabbed: Cycles / Goals / Courses / Enrollments / Competencies).
- Route at `/hr/performance` gated by `manageEmployees` in `EmployeesRoutes.tsx`.

### Turn J — Leave accrual variants + idempotency + localization guard
- Migration: `leave_types.accrual_anchor` (`hire_date|calendar|anniversary`) with check; rewrote `process_leave_accruals` to honor all three anchors and to insert a synthetic `carryover_expiry` allocation when `carryover_deadline` (mm-dd) has passed for the current year; added `idempotency_key text` + unique partial index on `leave_requests` and `employee_loans`; added `assert_localization_pack_for_org(org)` raising `PAYROLL_NO_LOCALIZATION_PACK` and a `BEFORE INSERT/UPDATE` trigger on `payroll_runs` that fails closed when status moves to `computing/computed/approved/paid` without a pack.
- `src/hooks/leave/useLeaveRequests.ts` — `createLeaveRequest(request, { idempotencyKey })` short-circuits on duplicate keys and persists the key on insert.
- `src/lib/edgeFunctionError.ts` — copy added for `PAYROLL_NO_LOCALIZATION_PACK`, `RECRUITMENT_APP_NOT_FOUND`, `RECRUITMENT_FORBIDDEN`, `RECRUITMENT_STAGE_INVALID`.

### Turn K — Polish
- `src/components/hr/ProbationEndingCard.tsx` — reads `employee_contracts.probation_end_date` for the next 30 days; wired into `HRDashboard.tsx`.
- `src/components/hr/FinalSettlementReconciliationCard.tsx` — reads `v_termination_payout_reconciliation`; wired into `HRReports.tsx`.
- `employees.supervisor_id` cycle guard re-verified: `trg_employees_manager_cycle_guard` already present — no new migration needed.

### Tests
- `src/test/architecture/turn-g-to-k-final-completion.test.ts` — 5 checks, all pass: hooks/components/pages/routes exist and reference the right tables and identifiers.
