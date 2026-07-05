
# Enterprise HCM Audit — Employee Management Subsystem

Verdict: **The foundation is genuinely enterprise-grade, but the operating layer on top of it is not.** The data model, pack-driven statutory engine, lifecycle event table, canonical employee view, RPC-based writes, and cross-module contracts (Payroll, Attendance, Time Off, Finance) already exceed what most mid-market ERPs ship. What is missing is the **operational HCM surface** — the workspaces that turn those events and tables into decisions. Today Employees behaves like a very well-engineered *directory* with satellite modules bolted on, not like a Workday-style Human Capital operating system.

Below is the detailed report. Implementation is deliberately deferred until you approve scope.

---

## 1. Current Architecture (as-is)

**Domain shape (Odoo-style, five sub-apps under `/hr/*`):**
```text
/hr
├── employees/*     Employees foundation (directory, profile, config, org)
├── contracts/*     employee_contracts + amendments + renewals
├── lifecycle/*     employee_lifecycle_events spine (mostly stubs)
├── talent/*        performance, goals, reviews, competencies, learning
├── reports/*       HR reports
├── attendance/*    hr_attendance
├── leave/*         hr_holidays
├── payroll/*       hr_payroll (runs, payslips, loans, statutory, remittances)
└── recruitment/*   hr_recruitment
```

**Data model highlights already in place:**
- `employees` base table + `v_employees_canonical` read view + `employees_active` operational view (draft/archived filtering enforced).
- `employee_lifecycle_events` — first-class event spine.
- `employee_contracts` + `contract_amendments` + `contract_compensation_components` + `employee_compensation_history` + `employee_position_history`.
- `employee_statutory_identifiers` + `country_statutory_catalog` + `pack_requirements` + `installed_localization_packs` — genuinely pack-driven.
- `entity_field_configs` / `entity_field_values` — custom fields with runtime validation.
- `employee_onboarding` + `onboarding_templates` + `onboarding_attempts` (with an HR-visible failure queue).
- `employee_exit_clearance` (+ items), `pending_termination_payouts`, `employee_advances`, `employee_loans`, `retro_pay_adjustments`.
- Governance layer: `governance_events`, `settings_audit_log`, `audit_logs`, `account_change_audit_log`, `sensitive_field_audit`.
- Server-side writes via RPC (`create_employee_with_identifiers`, `discard_employee_draft`, `link_employee_to_user`, `renew_contract`, `amend_contract`, `resolve_my_employee`, `hr_list_failed_onboarding_attempts`).
- Employee-module ESLint arch guards (`no-direct-employees-read`, `no-direct-employees-branch-write`) and pgTAP identity/uniqueness guard.

**Verdict at the architecture layer: strong.** This is a legitimate HCM data spine.

---

## 2. Employee Lifecycle Map (traced)

```text
                       Organization
                            │
                     Department ─── has ──► Positions (funded roles)
                            │                    │
                            ▼                    ▼
                     Work Location         Job Requisition ──► Candidate
                            │                                       │
                            │                                       ▼
                            │                              Offer letter
                            │                                       │
                            ▼                                       ▼
                   employees (draft)  ◄─── hire ─── candidate_applications
                            │
      create_employee_with_identifiers → employee_lifecycle_events(hired)
                            │
                            ▼
                      Onboarding template ─► employee_onboarding_items
                            │
                            ▼
                       Probation (policy: hr_policies.probation_period_months)
                            │
              ┌─────────────┼──────────────┬──────────────┬───────────────┐
              ▼             ▼              ▼              ▼               ▼
        Attendance     Time Off       Timesheets      Contracts       Documents
        (events,       (allocations,  (submissions,   (amendments,    (categories,
         devices)       requests)      approvals)      renewals)       expiries)
                                             │
                                             ▼
                                    Payroll (run groups, runs,
                                     payslips, YTD, remittances)
                                             │
                                             ▼
                                     Finance (GL, bank export,
                                       liabilities)
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
        Performance     Learning        Compensation
        (cycles,        (courses,       (bands, merit,
         goals,          enrollments,    retro pay)
         reviews)        quizzes)
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
         Succession   Promotion/       Transfer
         (plans,      Position         (dept/loc/mgr
          successors)  history)         change)
                            │
                            ▼
                       Termination
                            │
              ┌─────────────┼──────────────┐
              ▼             ▼              ▼
         Exit clearance  Final payout  Alumni (archived
         (items,         (pending_       lifecycle rows)
          checklist)      termination_
                          payouts)
```

Every transition **has a table**. Not every transition **has an operational workspace** — see §5.

---

## 3. Business-Event Flow (what actually fires)

Events that are wired end-to-end today:
- `employee.created` → identifiers inserted atomically, lifecycle row, onboarding template auto-application (via `hr_policies.default_onboarding_template_id`), account-linking eligibility check.
- `onboarding.attempt.failed` → `onboarding_attempts` + HR-visible queue (`/hr/employees/onboarding-issues`).
- `contract.renewed` / `contract.amended` → `renew_contract` / `amend_contract` RPCs + `contract_amendments` + compensation history rows.
- `payroll.run.finalized` → `payroll_liabilities`, `payroll_employee_ytd`, GL journal via `payroll_return_runs` pipeline.
- `attendance.session.opened` → `attendance` + `attendance_events`, business-tz aware.
- `leave.approved` → `leave_allocations` decrement + downstream payroll input.
- `termination.initiated` → `pending_termination_payouts` reconciliation card on HR dashboard.

Events that **fire silently or not at all**:
- `probation.ended` — no scheduled emitter; `ProbationEndingCard` reads the table but nobody flips the state.
- `contract.expiring` — computed on read, never emitted; no reminder pipeline, no owner queue that isn't a stub (`LifecycleRoutes` renders `WorkspaceComingSoon`).
- `employee.transferred` / `manager.changed` — `employee_position_history` exists but is written inconsistently; the Lifecycle "Transfers in flight" page is a stub.
- `document.expiring` — `employee_documents` has expiry columns but no reminder / renewal workflow.
- `hire.anniversary` / `birthday` — nowhere.
- `compensation.changed` — history table exists but there is no compensation review workflow calling into it beyond the raw editor.

**Architectural smell:** the event *spine* is real; the event *choreography* is partial. `business_event_outbox` exists and is used by POS/finance sagas but not by HR domain writes.

---

## 4. Cross-Module Dependency Graph

```text
                        ┌──────────────────┐
                        │  Employees (core)│
                        └──────────────────┘
                          │  emits  │  reads
     ┌────────────────────┼─────────┼─────────────────────┐
     ▼                    ▼         ▼                     ▼
  Recruitment         Payroll   Attendance             Time Off
  (candidate→hire)    (rules,   (devices, events,      (allocations,
                       runs)     schedules)             requests)
                          │         │                     │
                          └────┬────┴───────┬─────────────┘
                               ▼            ▼
                          Timesheets     Finance
                          (submissions)  (GL, bank export,
                                          liabilities, FX)
                               │
                               ▼
                          Performance ─► Learning ─► Succession
                                         │
                                         ▼
                                     Compensation (bands, merit, retro)
                                         │
                                         ▼
                        Employee Self Service (/me) — separate shell
                        Manager Self Service — partial (My Team, review inbox)
                        Reporting (/hr/reports) — separate workspace
```

Strong edges: Employees ↔ Payroll, Employees ↔ Attendance/Time Off, Payroll → Finance.
Weak / one-way edges: Recruitment → Employees (hire hand-off not automated), Performance → Compensation (merit recommendations exist but don't drive a run), Succession ↔ Positions (no vacancy binding), Documents ↔ Compliance (no renewal loop).

---

## 5. Workspace-by-Workspace Assessment

Legend: **A** = operational workspace, **B** = list/CRUD screen, **C** = stub/placeholder.

| Workspace | Grade | Findings |
|---|---|---|
| HR Overview (`/hr/dashboard`) | **A-** | Real KPIs, module inbox strip, probation card, termination reconciliation, analytics. Missing: expiring contracts, expiring documents, missing statutory fields count, headcount trend, anniversaries/birthdays, vacancies, compensation exceptions, compliance gaps, pending approvals (cross-module). Welcome banner + generic breakdown carry weight they don't earn. |
| Employee Directory (`/hr/employees`) | **B+** | Server-side paged, health filter, bulk actions, quick view, import wizard. It is a proper directory. It is **not** an operational control center — no saved views for "onboarding in flight / probation ending / missing statutory / contract expiring / documents expiring / unlinked users / never clocked in / recently transferred". Setup-health chip is close but only surfaces one dimension. |
| Employee Profile (`/hr/employees/:id`) | **A** | 12-section hub, legacy redirects, self-service field allowlist, own-profile vs admin gating, draft banner, export. Strong. Minor: no in-page timeline of *cross-module* events (payroll runs, leave taken, appraisals) — the "Activity Log" tab is admin-only and thin. |
| Departments (`/hr/employees/departments`) | **B** | 483 LOC, real CRUD, but departments are still effectively *labels*. No department budget rollup, no dept-level payroll cost, no headcount plan vs actual, no approval routing binding, no dept-owned dashboards. Manager assignment exists but does not drive an approver graph anywhere else. |
| Job Positions (`/hr/employees/positions`) | **B-** | 125 LOC — thin CRUD. Positions do not model funded headcount (no `authorized_headcount` / `filled_headcount` / `vacancies`), no salary band binding, no competency requirement rendering on the position itself (schema has `competency_role_requirements`), no requisition creation from a vacancy, no succession binding. This is the biggest single gap for an enterprise HCM. |
| Work Locations (`/hr/employees/locations`) | **B-** | 120 LOC list. Locations exist as reference data. They should drive: attendance geofencing (`attendance_devices` + `scan_events` mostly bind to branches, not locations), holiday calendar selection, timezone, shift eligibility, overtime rules. Today the linkage is implicit. |
| Org Chart (`/hr/employees/org-chart`) | **B** | Pure read-only tree built client-side from `manager_id`. Not an operational navigation layer — you cannot drag-reassign, cannot see reports' KPIs, cannot drill into leave/attendance/payroll from a node, cannot see vacancies inline, cannot filter by department/location. Fine as visualization, not as a control surface. |
| Configuration › Onboarding Templates | **B** | Real editor + template items, but templates are *checklists*, not *workflows*. No task assignees derived from roles, no due-date policy, no gating of probation start, no automatic doc-category coupling. |
| Configuration › Statutory Fields | **A** | Genuinely pack-driven, correctly refuses to hardcode identifiers, sends users to install a pack, exposes per-business overrides only. This is model-citizen behavior. |
| Configuration › Document Categories | **C+** | CRUD only. `is_required_for_onboarding` + `retention_days` exist in schema but are not enforced by any workflow. No expiry reminders, no renewal, no digital-signature binding. |
| Configuration › HR Policies | **B** | Probation months, notice days, leave year start, employee number format, default onboarding/offboarding templates, retire age. Consumed by directory + probation card. Not consumed by contracts, terminations, or leave accrual. Single-form UX; no policy history/audit surface even though `settings_audit_log` exists. |
| Configuration › Maintenance | **A-** | Real integrity tools: auto-link + stale-draft discard, both via secure RPCs with skip-reason reporting. Missing: duplicate identity detection, orphan lifecycle rows, contracts without compensation, employees without required statutory fields, users without employees. |
| Contracts (`/hr/contracts/*`) | **C** | Every sub-route except `/` is `WorkspaceComingSoon`. Schema is ready, UI is not. |
| Lifecycle (`/hr/lifecycle/*`) | **C** | Entire workspace is stubs. This is the spine that should tie everything together. |
| HR Reports (`/hr/reports/*`) | Not audited here (out of scope of Employees). |

---

## 6. Enterprise UX Assessment (persona-based)

- **HR Officer** opens `/hr/dashboard`: sees today's leave, checked-in count, probation ending, termination reconciliation. **Missing:** "what needs my attention today?" as a single queue across contracts expiring, documents expiring, onboarding stalled, statutory gaps, failed invitations.
- **HR Manager** opens `/hr/employees`: gets a search box and a table. **Missing:** saved operational views ("Probation review this month", "Contracts expiring in 60 days", "Missing KRA PIN", "Never clocked in", "Managers without direct reports").
- **Department Manager** opens `/hr/employees/org-chart`: sees a tree. **Missing:** "My team" scope with leave today, attendance today, timesheet approvals pending, appraisal status, vacancies open. The `MyTeamPage` in `/me` exists but is not surfaced from the org chart or department page.
- **Executive** has no headcount-plan-vs-actual, no cost-per-head trend, no attrition, no diversity — analytics widgets are shallow.
- **Payroll Officer** — well served by the payroll workspace itself; from Employees only the `EmployeeReadinessPanel` bridges over.
- **Recruiter** — Recruitment sub-app exists but the hand-off *into* Employees is not automated (candidate accepted → draft employee → onboarding kicked off is manual).

The three-question test ("What is happening / Why should I care / What should I do next?") passes on the Overview and Profile; it fails on Directory, Positions, Locations, Org Chart, Contracts, and Lifecycle.

---

## 7. Existing Strengths (do not touch)

1. Pack-driven statutory engine — genuinely dynamic, no hardcoded jurisdictions.
2. Canonical read model (`v_employees_canonical`) + arch tests + ESLint rule enforcing it.
3. RPC-based writes for identity-critical operations (create with identifiers, link, discard drafts) — atomic and auditable.
4. Draft lifecycle isolation — drafts never leak into payroll/attendance/directory operational views.
5. Onboarding failure visibility (`hr_list_failed_onboarding_attempts`).
6. Employee profile IA (12 sections, legacy redirects, self-service allowlist).
7. Governance/audit surfaces (`governance_events`, `settings_audit_log`, `sensitive_field_audit`).
8. Country-agnostic architecture — no `/hr/kenya/*`-shaped code anywhere.

---

## 8. Architectural Weaknesses

W1. **Lifecycle spine is data-only.** `employee_lifecycle_events` is written by some paths, ignored by others. No consistent emitter. No sagas subscribed.
W2. **Positions are titles, not funded roles.** No authorized headcount, no vacancy, no requisition binding.
W3. **Departments are labels, not business units.** No budget rollup, no dept-scoped dashboards, no approval binding.
W4. **Work locations are reference data.** Not consistently used by attendance/geofencing/holiday/timezone/overtime.
W5. **Contracts UI is missing.** Renewals, amendments, expiries — schema ready, no operator surface.
W6. **Documents have no compliance loop.** Expiry / retention / required-for-onboarding fields not enforced by workflows.
W7. **HR policies are not fully consumed.** Notice-period, probation-months influence some flows and not others (terminations, contracts, leave accrual).
W8. **Recruitment→Employees hand-off is manual.** No candidate.accepted → draft employee flow.
W9. **Cross-module inbox exists partially.** `ModuleInboxStrip` covers attendance/timesheets/time-off; missing contracts-expiring, documents-expiring, onboarding-stalled, probation-review, invitations-failed, statutory-gaps, compensation-exceptions.
W10. **Manager Self Service is fragmented.** `/me/team` exists but the org chart doesn't route through it, and department pages don't expose a manager-scoped view.
W11. **Compensation architecture is present but disconnected.** `salary_structures`, `salary_structure_rule_sets`, `merit_recommendations`, `retro_pay_adjustments`, `employee_compensation_history` — nothing binds them to a compensation-review cycle UI.
W12. **`business_event_outbox` is not used by HR writes.** POS/finance emit through it; HR writes do not.

---

## 9. Hardcoded vs Dynamic

- Statutory fields: **dynamic** (pack-driven). ✅
- Employee number format: **dynamic** (`hr_policies.employee_number_format`). ✅
- Probation months, notice days, leave year start, retire age: **dynamic** (`hr_policies`). ✅ but partially consumed.
- Onboarding template default: **dynamic** but only wired for onboarding (offboarding default column exists, template application on termination is not wired).
- Department/position/location: **dynamic** with FK IDs correctly resolved on import. ✅
- Custom fields: **dynamic** via `entity_field_configs`. ✅
- **Hardcoded that should not be:** the `HRDashboard`'s payroll math (`basic_salary + housing_allowance + transport_allowance`) — this assumes a specific compensation shape and ignores `contract_compensation_components` / `salary_components`. This is a real architectural smell — the dashboard should read from a compensation view, not from three columns.
- **Hardcoded that should not be:** the `Employees` dashboard `department` field is read as a string on many code paths despite `department_id` being the source of truth on the canonical view.

---

## 10. Dead / Disconnected Functionality

- `/hr/lifecycle/*` — every sub-page is a stub.
- `/hr/contracts/*` — every sub-page except overview is a stub.
- `succession_plans` / `successors` — schema and hooks exist; no operator surface from Employees.
- `talent_pools` / `talent_pool_members` — schema exists; not surfaced from a position or employee page.
- `competency_role_requirements` — schema exists; not surfaced on Job Positions.
- `employee_lifecycle_events` — written but not read by any dashboard.
- `pending_termination_payouts` — surfaced on dashboard, but no completion workflow.
- `governance_events` — written; no HR-facing "who changed what" browser inside Employees (audit-log tab is per-employee only).

---

## 11. Missing Business Capabilities (in Workday/SAP/Odoo terms)

M1. Position management (authorized headcount, vacancies, requisitions).
M2. Contract lifecycle UI (drafts, expiring, renewals, amendments, templates).
M3. Employee lifecycle operator queues (onboarding stalled, probation ending, transfers in flight, offboarding in flight, renewals due, archive).
M4. Compensation review cycle (band binding on positions, merit rounds, retro apply).
M5. Document compliance loop (expiries, renewals, required-for-onboarding gating).
M6. Cross-module HR inbox ("what needs my attention today").
M7. Manager Self Service surface consistent with employee/dept/org-chart entry points.
M8. Recruitment→Employees automated hand-off (candidate accepted → draft employee + onboarding).
M9. Anniversary / birthday / probation-end automations.
M10. Department budget & headcount plan, position-level vacancy tracking.
M11. Duplicate-identity and orphan-integrity checks in Maintenance.
M12. HR event outbox emission on every material Employee write (to unlock sagas + notifications).

---

## 12. Risk-Ranked Implementation Plan

Grouped so each turn ships a coherent, standalone improvement.

**Wave A — Operator surfaces (highest ROI, low schema risk)**
1. Lifecycle sub-app — replace stubs with real queues over `employee_lifecycle_events` (Onboarding in flight, Probation ending, Transfers in flight, Renewals due, Offboarding in flight, Archive, All events).
2. Contracts sub-app — real screens for Drafts / Pending / Active / Expiring (30/60/90) / Renewals / Amendments / Templates / Audit; uses existing `renew_contract` / `amend_contract` RPCs.
3. HR cross-module inbox — extend `ModuleInboxStrip` to include contracts-expiring, documents-expiring, onboarding-stalled, probation-review, failed-invitations, statutory-gaps.
4. Directory saved operational views (probation-ending, contract-expiring, missing-statutory, onboarding-stalled, unlinked-users, never-clocked-in, recently-transferred).

**Wave B — Position management (real HCM capability)**
5. Job Positions upgrade: `authorized_headcount`, `filled_headcount`, `vacancies` (computed), salary band binding, competency requirements panel, "Open requisition from vacancy" action, succession binding.
6. Departments as business units: headcount plan vs actual card, dept payroll cost from `payroll_runs`, dept-scoped inbox, approval routing binding.

**Wave C — Compliance & documents**
7. Document expiry / renewal workflow — driven by `hr_document_categories.is_required_for_onboarding` + expiry columns, feeds inbox.
8. Onboarding template as workflow — role-based assignees, due-date offsets from hire date, gating probation start.

**Wave D — Event choreography**
9. HR write emitters into `business_event_outbox` (hired, probation_started/ended, transferred, contract_renewed, contract_amended, terminated, archived, document_expiring, statutory_gap_detected).
10. Sagas that subscribe: probation-end scheduler, contract-expiry notifier, document-expiry notifier, anniversary/birthday emitter.

**Wave E — Compensation cycle**
11. Salary band model bound to positions; merit recommendation round UI that consumes `merit_recommendations` and emits `payroll_correction_adjustments` / `retro_pay_adjustments`.
12. Compensation history browser inside profile Contracts section (already stubbed).

**Wave F — Recruitment→Employees**
13. `candidate.accepted` → `create_employee_with_identifiers` (draft) + onboarding template auto-application; add reversible undo window.

**Wave G — Executive analytics**
14. Headcount trend, attrition, cost-per-head, span-of-control, diversity — read from `v_employees_canonical` + `payroll_runs` + `employee_lifecycle_events`.

**Wave H — Maintenance depth**
15. Duplicate identity detection, orphan lifecycle rows, employees missing required statutory fields, users without employees — all as Maintenance cards.

**Non-goals for this audit's follow-up work:**
- No visual redesign of existing profile / directory.
- No changes to pack schema, statutory catalog, or canonical view.
- No re-architecture of the five-sub-app split — it is correct.
- No changes to Payroll, Attendance, or Time Off internals beyond emitter subscriptions.

---

## 13. Final Verdict

Architecturally: **preserve.** The schema, the canonical view, the pack engine, the RPC write layer, the arch tests, the audit surfaces — all of these are already at enterprise-HCM caliber and should be treated as immutable.

Operationally: **build the missing workspaces.** Lifecycle, Contracts, Positions-as-funded-roles, Compensation cycle, Document compliance loop, and the HR cross-module inbox are the six deliverables that convert this from "very good HR data platform" into "Workday-class Employee subsystem."

Approve this plan and I will start with **Wave A** (Lifecycle real queues → Contracts real screens → HR inbox expansion → Directory saved views), which unlocks the most operator value with the least schema movement.
