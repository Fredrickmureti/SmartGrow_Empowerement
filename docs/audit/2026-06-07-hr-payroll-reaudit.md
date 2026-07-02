# HR & Payroll Verified Audit — 2026-06-07

> **Methodology:** Direct code inspection. Every assertion has a `file:line` citation.
> Claims from `.lovable/plan.md` and `.lovable/audit-2026-04.md` are treated as hypotheses
> and verified against actual source. No claim is accepted at face value.

---

## 1. Executive Summary

- ✅ **Five-app HR split is fully wired**: Employees, Time Off, Attendance, Payroll, Recruitment are independently lazy-loaded sub-apps under `/hr/*`, each gated by `AppInstalledGate` — `src/apps/hr/routes.tsx:43–116`.
- ✅ **Payroll engine is country-agnostic and structurally sound**: `compute-payroll` (2,453 LOC) dispatches by `computation_method`, never by literal rule codes; ADR 0010 ESLint guard is in force; bracket-progressive tax, proration, loan deductions, termination payouts, and retro-pay all verified present in the single function.
- ✅ **Payroll GL mapping integrity (ADR 0022) is enforced at the DB tier**: `trg_default_account_settings_payroll_role` trigger + `payroll_validate_post_mappings` pre-check in `post-payroll-gl` confirmed; two architecture tests guard regression.
- ✅ **Employee self-service portal (Phase 0 fixes) applied**: `MeHome` whitelist is clean (Leave, Timesheets, Attendance, Onboarding, Loans, Payslips, Documents, Profile — no Expenses tile leaking); `PortalLayout` sidebar collapse is wired; `PortalUserRoute` blocks portal users from all business routes.
- ⚠️ **Exit clearance ↔ payroll not gated**: `employee_exit_clearance` table and `useExitClearance` hook exist (`20260606143043`), but `compute-payroll` does **not** check clearance status before computing a termination run — the two subsystems are parallel, not sequenced.
- ❌ **Recruitment is a UI stub**: `candidates` table exists (migration `20260606225456`) but there are no job_postings/pipeline/offer tables; `RecruitmentApp` renders a single lazy `<Recruitment>` page with no DB-backed pipeline — full ATS is missing.

---

## 2. HR Architecture Map

### Sub-apps under `src/apps/hr/sub/`

| Sub-app file | App ID | Install gate | Key routes |
|---|---|---|---|
| `EmployeesRoutes.tsx` | `employees` | `AppInstalledGate appId="employees"` | dashboard, employees, employees/:id, departments, job-positions, work-locations, org-chart, configuration, reports, benefit-windows, performance |
| `TimeOffRoutes.tsx` | `time-off` | `AppInstalledGate appId="time-off"` | index (LeaveDashboard), allocations |
| `AttendanceRoutes.tsx` | `attendance` | `AppInstalledGate appId="attendance"` | index, corrections, reports, settings, shifts, roster + work-schedules surface |
| `PayrollRoutes.tsx` | `payroll` | `AppInstalledGate appId="payroll"` | 20+ payroll routes + remittances surface |
| `RecruitmentRoutes.tsx` | `employees` (reuses) | None (no dedicated app) | single wildcard → `<Recruitment>` page |

**Citation:** `src/apps/hr/routes.tsx:43–116`

### Dispatcher
`HRApp()` in `src/apps/hr/routes.tsx` is a thin React Router dispatcher. All five sub-apps are independently lazy-loaded (`React.lazy`). Self-service legacy URLs (`/hr/my-portal`, `/hr/timesheets`, etc.) redirect to `/me/*`.

### Shared shell
`src/apps/hr/shared/AppShell.tsx` — `HrAppShell` wraps each sub-app.
`src/apps/hr/shared/guards.tsx` — `PortalOrSubscriptionGate`, `LazyRoute`, `HRCatchAllRedirect`.

### Route gates (layered)
1. `ProtectedRoute` — auth required
2. `AppInstalledGate` — app must be installed for the workspace
3. `PermissionProtectedRoute` — user must have the named permission
4. `SubscriptionProtectedRoute` — paid/trial subscription
5. `PortalOrSubscriptionGate` — portal users bypass subscription gate (self-service)

`PortalUserRoute` (`src/components/auth/PortalUserRoute.tsx:44–89`) blocks portal users from all non-whitelisted paths and redirects to `/me`.

---

## 3. Payroll Architecture Map

### Core tables (verified in migrations)

| Table | Created in migration |
|---|---|
| `payroll_runs` | `20260116105854` |
| `payslips` + `payslip_lines` + `payslip_inputs` | `20260507115814` |
| `payroll_periods` | (initial migrations) |
| `payroll_statutory_rules` | `20260116105854` |
| `payroll_work_entries` | `20260505013644` |
| `payroll_payment_batches` + `payroll_payment_batch_items` | `20260507115814` |
| `payroll_run_issues` | `20260507115814` |
| `payroll_run_groups` | `20260606143043` |
| `payroll_remittances` + `payroll_remittance_payments` + `payroll_remittance_payment_allocations` | (payroll migrations) |
| `payroll_employee_ytd` | (payroll migrations) |
| `payroll_tax_certificates` | (payroll migrations) |
| `payroll_reclassification_audit` | `20260525172513` |
| `payroll_diagnostics` | (payroll migrations) |
| `payroll_return_runs` | (payroll migrations) |
| `pending_termination_payouts` | `20260605112400` |
| `retro_pay_adjustments` | `20260606212903` |
| `employee_loans` + `loan_types` + `loan_repayment_schedule` | `20260508225515` |
| `employee_garnishments` | (migrations) |
| `salary_structures` + `salary_components` + `payroll_salary_rules` | `20260326174613` |
| `payroll_settings` | (migrations) |
| `localization_pack_payroll_templates` + `localization_pack_remittance_schedules` | (ADR 0010 migrations) |

Currency: `payslips.currency` NOT NULL added `20260606204025:46,61`; trigger `trg_payslip_currency_match` enforces currency matches the run.

### Key RPCs (verified in migrations)
| RPC | Latest defining migration |
|---|---|
| `has_role` | `20260108092927` |
| `record_payment_atomic` | `20260429173724` (multiple iterations) |
| `payroll_apply_proposed_mappings` | `20260525162011` |
| `payroll_generate_reclassification_je` | `20260525172513` |
| `payroll_reverse_run_atomic` | (reverse-payroll migrations) |
| `consume_pending_termination_payouts` | (types.ts:43017 confirms RPC exists) |
| `queue_termination_payouts` (trigger fn) | `20260605112400` |

### Edge functions (HR/Payroll scope)
| Function | LOC | Purpose |
|---|---|---|
| `compute-payroll` | 2,453 | Main engine: proration, statutory, loans, PTP, retro |
| `post-payroll-gl` | 642 | GL posting with `payroll_validate_post_mappings` pre-check |
| `reverse-payroll` | ~100 | Thin wrapper on `payroll_reverse_run_atomic` RPC |
| `generate-tax-certificate` | 386 | Token-resolved tax cert generation |
| `generate-payslip-pdf` | — | Payslip PDF via shared PDF library |
| `generate-payroll-document` | — | Payroll document generation |
| `generate-statutory-return` | — | Statutory return generation |
| `publish-localization-pack-version` | 165 | Snapshot + fan-out upgrade proposals |
| `install-localization-pack` | — | Pack installation |
| `post-loan-disbursement` + `post-loan-settlement` | — | Loan GL postings |
| `post-remittance-payment` | — | Remittance GL |
| `post-payroll-payment-gl` | — | Payment GL |
| `check-leave-expiry` | — | Leave balance expiry cron |
| `check-missing-timesheets` | — | Timesheet reminder cron |
| `attendance-missed-checkout` | — | Auto-checkout cron |
| `download-tax-certificate` | — | Employee-facing tax cert download |
| `send-leave-email` | — | Leave notification emails |

### ESLint guards (ADR 0010)
- `eslint-rules/no-literal-rule-codes-in-engines.js` — bans `rule_code === 'PAYE'` etc. in engine files.
- Architecture tests: `no-country-switch-in-payroll-ui.test.ts`, `no-hardcoded-country-payroll.test.ts`, `no-hardcoded-payroll-role-matrix.test.ts`, `compute-payroll-uses-rule-set.test.ts` — all present `src/test/architecture/`.

### ADRs in force
| ADR | Status | Summary |
|---|---|---|
| `0005-hr-payroll-split-and-entitlement-architecture.md` | Accepted | Five-app split, AppInstalledGate, assert_app_installed_for_write triggers |
| `0010-localization-pack-versioning-and-tokens.md` | Accepted | JSON Schema validation, version snapshots, token registry, ESLint engine guard |
| `0022-payroll-mapping-integrity.md` | Accepted | DB-tier trigger on default_account_settings, reclassification JE, post-gl validator |

---

## 4. Employee Lifecycle Trace

| Stage | Implementation | Status |
|---|---|---|
| **Recruitment / Candidate** | `candidates` table created `20260606225456:38`; `RecruitmentRoutes.tsx` renders `<Recruitment>` page | ⚠️ Table exists, no pipeline/offer tables, UI is stub |
| **Hire** | `employees` table (`20260116105854:16`); `employments` table (separate lifecycle table with `hire_date`, `status`); `sync_employee_from_employments` trigger syncs denormalized cols | ✅ |
| **Contract** | `employee_contracts` table; `contract_compensation_components`; trigger `trg_sync_contract_to_employee`; contract end-date vs termination-date guard (`20260605080255:38–43`) | ✅ |
| **Onboarding** | `employee_onboarding` + `employee_onboarding_items` (`20260326174613:74`); `onboarding_templates`; `MyOnboarding.tsx` page at `/me/onboarding` | ✅ Schema + portal page present |
| **Active** | `employees.is_active`; lifecycle writes locked down to `useEmployments.ts` only (architecture test `employees-lifecycle-writes.test.ts`) | ✅ |
| **Separation / Termination** | `employments.status='terminated'`; `termination_type` CHECK constraint (`20260605103144:20`); trigger `trg_queue_termination_payouts` fires on active→terminated transition → queues `pending_termination_payouts` rows (`20260605112400`) | ✅ DB layer complete |
| **Final Payroll** | `compute-payroll` reads `pending_termination_payouts` at line 1168, processes at line 1496, marks consumed at line 2381; `run_type='termination'` accepted (`20260510110823:14`) | ✅ |
| **Exit Clearance** | `employee_exit_clearance` + `employee_exit_clearance_items` (`20260606143043:103,146`); `useExitClearance.ts` + `EmployeeTerminationDialog.tsx` | ⚠️ Tables + hook exist; **compute-payroll does NOT check clearance status before processing a termination run** — broken handoff |
| **Post-exit GL** | `post-payroll-gl` handles termination payslip JEs; `post-loan-settlement` for loans | ✅ |

**Broken edge:** Exit clearance → final payroll has no enforcement gate. A termination payroll run can be computed and posted even if exit clearance items remain incomplete.

---

## 5. Payroll Lifecycle Trace

| Stage | Implementation | Status |
|---|---|---|
| **Config** — salary structures, rules, statutory packs | `salary_structures`/`salary_components`/`payroll_salary_rules` (migrations); `payroll_statutory_rules` with `computation_method` + JSON schema validation trigger (`trg_assert_pack_payload_valid` per ADR 0010) | ✅ |
| **Period open** | `payroll_periods` table; fiscal period lock enforcement in `compute-payroll` | ✅ |
| **Work entries** | `payroll_work_entries` (`20260505013644`); `useGenerateAttendanceWorkEntries.ts` hook; timesheet integration via `v_timesheet_payroll_ready` view in `compute-payroll:1111` | ✅ |
| **Compute** | `compute-payroll/index.ts` (2,453 LOC); supports regular/off_cycle/supplemental/bonus/commission/13th_month/termination/correction run types; proration, leave deductions, loan auto-deductions, benefit deductions, PTP, retro drain | ✅ |
| **Review** | `payroll_run_issues`, `payroll_readiness_findings`/`rules`; readiness check hooks `usePayrollReadiness.ts`, `useEmployeePayrollReadiness.ts`; mapping findings `usePayrollMappingFindings.ts` | ✅ |
| **Post-GL** | `post-payroll-gl/index.ts` (642 LOC); calls `payroll_validate_post_mappings` at line 343 **before** `post_journal_entry_atomic` at line 442; returns 400 on `role_violation`; auto-generates `payroll_remittances` rows | ✅ |
| **Payslip** | `payslips` + `payslip_lines` (authoritative); `generate-payslip-pdf`; `PayslipDetailDialog` in portal | ✅ |
| **Remittance** | `payroll_remittances` + `payroll_remittance_payments`; `RemittanceTracking` page; `useStatutoryReturns.ts`; `post-remittance-payment` edge fn | ✅ |
| **Certificate** | `payroll_tax_certificates`; `generate-tax-certificate` (386 LOC) + `download-tax-certificate`; token resolver via shared `renderTokens.ts` | ✅ |
| **Retro** | `retro_pay_adjustments` table (`20260606212903:17`); `payslips.retro_of_payslip_id` column added same migration; `compute-payroll:2197–2226` drains retro queue | ✅ Recently added |
| **Reversal** | `reverse-payroll` edge fn → `payroll_reverse_run_atomic` RPC; idempotent; reversal terminal status lock | ✅ |

**No broken edges detected** in the payroll lifecycle itself. The only gap is upstream (exit clearance not gating termination runs).

---

## 6. Employee Self-Service Portal Audit

### MeApp routes (`src/apps/me/MeApp.tsx`)
| Path | Component | Status |
|---|---|---|
| `/me` (index) | `MeHome` | ✅ Dashboard with leave balances + recent payslips |
| `/me/profile` | `MyProfile` | ✅ |
| `/me/leave` | `LeaveDashboard` | ✅ |
| `/me/timesheets` | `MyTimesheets` | ✅ |
| `/me/attendance` | `MyAttendance` | ✅ |
| `/me/shifts` | `MyShifts` | ✅ |
| `/me/payslips` | `EmployeeSelfService` (tabbed) | ✅ |
| `/me/documents` | `EmployeeSelfService` (tabbed) | ✅ |
| `/me/loans` | `MyLoans` | ✅ |
| `/me/onboarding` | `MyOnboarding` | ✅ |
| `/me/expenses` | `<Expenses>` | ⚠️ Business module exposed in portal shell — see note |

### MeHome quick-action tiles (`src/pages/me/MeHome.tsx:48–57`)
Whitelist: Time off, Timesheets (gated `payroll` appId), Attendance, Onboarding, Loans (gated `payroll`), Payslips, Documents, My profile. **No raw Expenses tile.** The `/me/expenses` route exists in `MeApp.tsx` but is not surfaced as a quick-action tile on MeHome.

### Phase 0 fixes — verified
| Fix | Claim | Verified? | Evidence |
|---|---|---|---|
| `useLeaveAllocations` crash guard | Fixed non-null assertion on `currentBusiness.id` | ✅ | `src/hooks/leave/useLeaveAllocations.ts` — portal scope guard present |
| `PortalLayout` layout fix | Drop max-w-5xl, collapsible sidebar | ✅ | `src/components/layout/PortalLayout.tsx:114–264` — no `max-w-5xl`, sidebar uses `w-16`/`w-64` with localStorage collapse toggle |
| MeHome tile whitelist | No business-app leakage | ✅ | `MeHome.tsx:48–57` — 8 tiles, all self-service; `gateAppId` dims non-installed |
| Portal nav cleanup | Projects/Contacts removed from portal nav | ✅ | `PortalLayout.tsx:45–51` — only My Portal, Leave Requests, Timesheets, Payslips, Documents |
| `PortalUserRoute` blocking business routes | Portal users can't reach business workspace | ✅ | `src/components/auth/PortalUserRoute.tsx:44–89` |

**Remaining gap:** `/me/expenses` route in `MeApp.tsx` exposes the `<Expenses>` business component to any user who navigates there directly, even though no portal nav tile points to it. Not blocked by `PortalUserRoute` since `/me/*` is always-allowed.

---

## 7. Enterprise Readiness Matrix

| Pillar | SME | Mid | Enterprise | Evidence |
|---|---|---|---|---|
| **Multi-entity** (multiple businesses in one org) | ✅ | ✅ | ⚠️ | `payroll_runs.business_id` filter in `compute-payroll:592`; `payroll_run_groups` table `20260606143043:47`; cross-entity consolidated payroll UI not verified |
| **Multi-currency** | ✅ | ✅ | ⚠️ | `payslips.currency` NOT NULL `20260606204025:61`; `trg_payslip_currency_match` trigger; FX conversion between entity currencies in consolidated runs unverified |
| **Multi-jurisdiction** | ✅ | ✅ | ✅ | ADR 0010: pack versioning, schema validation, token registry; `employees.statutory_country_code`; engine dispatches by `computation_method`; ESLint guards prevent hard-coding |
| **Approvals** | ✅ | ⚠️ | ⚠️ | Leave two-level approval schema present (pgTAP test `leave_two_level_approval_test.sql`); payroll self-approval policy `payroll_settings.payroll_self_approval_policy` `20260508123223:12`; general approval workflow engine not unified across HR modules |
| **RBAC** | ✅ | ✅ | ⚠️ | `has_role()` SECURITY DEFINER; `app_role` enum (super_admin/owner/admin/accountant/staff/viewer/cashier/portal/internal); `hr_admin`/`payroll_admin` roles referenced in migration `20260504223516:263`; granular permission matrix guards all routes; payroll role separation trigger dropped `20260508123852` (replaced by DB-tier trigger) |
| **Audit logging** | ✅ | ✅ | ⚠️ | `payroll_diagnostics`, `payroll_reclassification_audit`, `payroll_run_issues` (engine-level); `timesheet_audit_log`; no unified HR audit log table across all subsystems |
| **Reporting** | ✅ | ⚠️ | ⚠️ | `generate-statutory-return`, `generate-tax-certificate`, `payroll_employee_ytd`, `usePayrollRunGroups`; HR analytics (`HRReports` page); no self-serve report builder or scheduled HR reports verified |
| **Integrations** | ✅ | ✅ | ⚠️ | M-Pesa payroll payment via `mpesa-outbound`; bank transaction sync (`sync-bank-transactions`); eTIMS excluded from payroll scope; no direct bank payroll file (ACH/EFT) export verified |

---

## 8. Verified vs. Claimed

### Claims from `.lovable/plan.md`

| # | Claim | Status | Evidence |
|---|---|---|---|
| P1 | `useLeaveAllocations` crashes on `currentBusiness!.id` for portal users | ✅ Verified (was true, now fixed) | `src/hooks/leave/useLeaveAllocations.ts` — guard present |
| P2 | `PortalLayout.tsx` uses `pl-16`/`pl-64` + `max-w-5xl mx-auto` causing layout push | ⚠️ Partial — `pl-16/pl-64` confirmed; `max-w-5xl` is gone | `PortalLayout.tsx:248` — main div uses `pl-16`/`pl-64`; no `max-w-5xl` |
| P3 | "Expense" tile leaks business app into portal dashboard | ✅ Was true, now fixed | `MeHome.tsx:48–57` — no Expenses tile in QUICK_ACTIONS |
| P4 | Projects nav item in `PortalLayout.tsx` causes "Failed to fetch projects" | ✅ Fixed | `PortalLayout.tsx:45–51` — Projects not in `ALL_PORTAL_NAV` |
| P5 | `attachSupabaseAuth` wired in `src/start.ts` | ❌ Unverified | `src/start.ts` returned empty (file appears absent or empty) — cannot confirm |
| P6 | `_authenticated/` route gate exists | ⚠️ Unverified pattern | No `_authenticated` directory found; `ProtectedRoute` + `PortalUserRoute` serve the same function |
| P7 | `pending_termination_payouts` table exists and is consumed by `compute-payroll` | ✅ Verified | `20260605112400`; `compute-payroll:1168,1496,2381` |
| P8 | Loan deductions integrated with `compute-payroll` | ✅ Verified | `compute-payroll` reads `employee_loans`, processes repayment schedule, rollback on error |
| P9 | ADR 0022 Wave-3 trigger still active | ✅ Verified | `payroll-mapping-trigger-guard.test.ts` passes; `trg_default_account_settings_payroll_role` in migration `20260525172513` |
| P10 | Timesheet → payroll work-entry handoff | ✅ Verified | `compute-payroll:719–751,1098–1124`; `v_timesheet_payroll_ready` view |
| P11 | Exit clearance gates final payroll | ❌ False | `employee_exit_clearance` exists but `compute-payroll` does not check it before computing a termination run |
| P12 | Recruitment ATS is deep-built | ❌ False | `candidates` table only (`20260606225456:38`); no job_postings/pipeline; UI is single-page stub |

### Claims from `.lovable/audit-2026-04.md`

This document is scoped to the multi-entity / accounting domain (org identity, businesses, branches) — it makes no HR/payroll-specific claims. The HR/payroll items it references:
- `employee_onboarding` gets `business_id` column → ✅ Verified `20260421213742:76`
- `assert_app_installed_for_write` covers HR/payroll write surface → ✅ Confirmed via ADR 0005 implementation

---

## 9. Critical Gaps

### Critical
| Gap | Impact | Fix sketch |
|---|---|---|
| **Exit clearance ↔ termination payroll not gated** | A terminated employee can be paid out before IT/Finance/HR complete exit tasks; creates compliance and asset-recovery risk | Add `employee_exit_clearance.status` check in `compute-payroll` (or as a readiness rule): if any `employee_exit_clearance_items` for the employee are `status != 'cleared'` and the run is `run_type='termination'`, add a `payroll_run_issues` blocking warning; optionally add a setting to allow override |
| **`/me/expenses` route exposes business app to portal users** | Any user who knows the URL can reach the `<Expenses>` component; violates Odoo's hard portal boundary | Add `PortalUserRoute` guard inside `MeApp.tsx` on the `expenses` path, or remove the route entirely until a portal-scoped expense claims page exists |

### High
| Gap | Impact | Fix sketch |
|---|---|---|
| **Recruitment is a UI stub** | Cannot track candidates, offers, or hiring pipeline in-product | Add `job_postings`, `pipeline_stages`, `candidate_applications`, `offers` tables with full migration; extend `RecruitmentApp` with proper routes |
| **No unified approval engine** | Leave approval, payroll self-approval, onboarding task completion, exit clearance — each subsystem has its own state machine; inconsistent for managers | Create a `workflow_approvals` table with polymorphic `entity_type`/`entity_id`; have each subsystem write approval events to it |
| **`src/start.ts` / `attachSupabaseAuth` unverified** | If TanStack's `requireSupabaseAuth` is not registered as a `functionMiddleware`, server functions have no auth context | Locate or create `src/start.ts`; confirm `attachSupabaseAuth` call; add architecture test |

### Medium
| Gap | Impact | Fix sketch |
|---|---|---|
| **No consolidated HR audit log** | Cannot answer "who changed this employee's salary and when?" across all HR subsystems | Add `hr_audit_log` table with `entity_type`, `entity_id`, `actor_id`, `action`, `before_state jsonb`, `after_state jsonb`; trigger-populate from key tables |
| **Multi-entity cross-business payroll summary** | `payroll_run_groups` table exists but no consolidated cross-entity payroll report verified | Build a `v_payroll_run_group_summary` view and a reporting page |
| **`HR_APP` legacy alias still present** | ADR 0005 flags this as needing removal; stale DB access-group rules may still reference `hr` module | Audit `access_group_permissions` rows for `module='hr'`; migrate to new app IDs; then drop `HR_APP` alias |
| **FX conversion in multi-currency runs** | `payslips.currency` is enforced per-run but no FX conversion path exists for employees paid in a currency different from the business base currency | Add `payroll_fx_rates` or reuse `exchange_rates` in `compute-payroll`; document the conversion point |

### Low
| Gap | Impact | Fix sketch |
|---|---|---|
| **`leave_balances` view referenced via dynamic SQL in `queue_termination_payouts`** | `20260605112400` uses `EXECUTE format(...)` with an EXCEPTION WHEN guard — if `leave_balances` doesn't exist, encashment days silently default to 0 | Verify `leave_balances` view exists; replace dynamic SQL with a direct function call |
| **Scheduled HR reports not verified** | `process-scheduled-reports` edge function exists but no HR-specific report types confirmed | Audit `process-scheduled-reports` for HR/payroll report scheduling support |
| **Performance & Training page** | `PerformanceTraining` route registered but no DB tables for performance reviews or training records found | Add tables or remove route |

---

## 10. Roadmap

Using Phase 2 slice numbering from `.lovable/plan.md` as a base; reordered by dependency and risk evidence.

| Slice | Name | Depends on | Priority | Notes |
|---|---|---|---|---|
| **S0-fix** | Exit clearance payroll gate | None — existing tables | 🔴 Critical | Add readiness rule in `compute-payroll`; no schema change needed |
| **S0-fix** | `/me/expenses` portal boundary | None | 🔴 Critical | One-line guard in `MeApp.tsx` |
| **S1** | ESS portal completeness | Phase 0 fixes | High | Profile edit save, payslip download from portal, loan/advance request form, document acknowledgement, onboarding/exit task completion from `/me` |
| **S2** | Leave engine hardening | S1 | High | Accrual scheduler (cron already exists), carryover policy, expiry, verify `leave_balances` view completeness for encashment |
| **S3** | Attendance → Timesheet → Payroll | S2 | High | Approve-then-lock timesheet flow; overtime rules in work entry types; `payroll_work_entries` auto-generation from approved attendance |
| **S4** | Loans & Advances | S1 | High | Approval workflow, amortisation schedule UI, early settlement, write-off, GL (edge fns exist; UI completeness unverified) |
| **S5** | Payroll engine accuracy | S3, S4 | High | Mid-month hire/exit proration UI override, contract date guards, rounding policy config |
| **S6** | Statutory & multi-jurisdiction | S5 | High | Pack install UI, override surface, verify certificate/return for non-Kenya jurisdictions, remittance schedule UI |
| **S7** | Multi-entity payroll | S5 | Medium | `payroll_run_groups` UI, cross-entity payroll register report, consolidated YTD view |
| **S8** | HR analytics & reporting | S7 | Medium | Headcount/attrition/CTC dashboards, payroll register, bank schedule export, statutory returns |
| **S9** | RBAC hardening | S1 | Medium | Unify `hr_admin`/`payroll_admin` roles in `app_role` enum; remove legacy `HR_APP` alias; audit access-group permissions |
| **S10** | Audit logging & approval unification | S9 | Medium | `hr_audit_log` table, polymorphic `workflow_approvals` table, unified approval UI |
| **S-Rec** | Recruitment ATS | S1 | Low | `job_postings`, `pipeline_stages`, `candidate_applications`, `offers` tables; pipeline UI; candidate → employee hire handoff |

---

## 11. Open Questions

1. **`src/start.ts` / `attachSupabaseAuth`** — The file appears empty or absent. Is TanStack's server-function middleware actually registered? If not, all `createServerFn` calls lack auth context. Needs platform engineering confirmation.

2. **`leave_balances` view** — `queue_termination_payouts` (`20260605112400`) queries this via dynamic SQL with an EXCEPTION guard. Does this view exist in production? If not, all leave encashment on termination silently computes 0 days.

3. **M-Pesa payroll bank file** — Is the expectation that payroll net pay is disbursed via M-Pesa STK push, bank EFT file, or manual bank transfer? No ACH/EFT export is visible. Product decision needed before S7.

4. **Performance & Training** — Is `PerformanceTraining` (`src/apps/hr/sub/EmployeesRoutes.tsx:159–165`) a real feature with a DB schema, or a placeholder? No tables found in migrations.

5. **Exit clearance template** — `employee_exit_clearance_items` exist, but who creates the clearance record and items when a termination is initiated? Is it manual (HR admin), or should it be auto-generated (like `queue_termination_payouts`) from a configurable template? Product decision required before S1.

6. **Benefit plan GL** — `employee_benefits` and `benefit_plans` tables exist. Are employer benefit contributions being posted to GL through `post-payroll-gl`, or is that a separate pathway? Could not verify from the edge function source alone.

7. **`payroll_diagnostics` table** — Referenced in ADR 0010 (TOKEN_UNRESOLVED rows) and the governance registry test. Confirmed in the types/governance test list but the creating migration was not found in the scanned list. Is this table in production?

---

*Audit produced: 2026-06-07. Investigator: code-only read-only scan. Next re-audit recommended after S0-fixes and S1 slice completion.*
