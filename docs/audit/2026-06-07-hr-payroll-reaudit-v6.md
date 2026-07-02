# HR/Payroll Re-Audit v6 — 2026-06-07

> Auditor: automated codebase scan (rg / cat / ls).
> Every non-trivial claim is cited `file:line`. "Unverified" = not found in scanned files.
> Prior agent claims are marked ✅ / ⚠️ / ❌ / 🚫 with evidence.

---

## 1. HR Architecture Map

### Sub-apps under `src/apps/hr/sub/`

| File | App ID | URL Prefix | AppInstalledGate? | internalOnly |
|---|---|---|---|---|
| `EmployeesRoutes.tsx` | `employees` | `/hr/*` (catch-all) | ✅ (`appId="employees"`) | ✅ (registry.ts:80+) |
| `TimeOffRoutes.tsx` | `time-off` | `/hr/leave/*` | ✅ (`appId="time-off"`) | ✅ |
| `AttendanceRoutes.tsx` | `attendance` | `/hr/attendance/*`, `/hr/work-schedules/*` | ✅ (`appId="attendance"`) | ✅ |
| `PayrollRoutes.tsx` | `payroll` | `/hr/payroll/*`, `/hr/remittances/*` | ✅ (`appId="payroll"`) | ✅ |
| `RecruitmentRoutes.tsx` | `recruitment` | `/hr/recruitment/*` | ❌ No `AppInstalledGate` wrapping in routes.tsx:52 | ✅ |

**`src/apps/hr/routes.tsx:52`**: `<Route path="recruitment/*" element={<RecruitmentApp />} />` — **no `AppInstalledGate`**. Every other sub-app is gated; Recruitment is not. A user can reach `/hr/recruitment` even without the app installed.

### Shared shell
`HrAppShell` is imported from `src/apps/hr/shared/AppShell` and used in all five sub-app route files. Each sub-app passes its own `AppDefinition` constant (`EMPLOYEES_APP`, `PAYROLL_APP`, etc.) so the topbar always shows the correct module list (`EmployeesRoutes.tsx:31`, `PayrollRoutes.tsx:14`).

### Self-service legacy redirects
`routes.tsx:99-103`: `/hr/my-portal → /me`, `/hr/my-profile → /me/profile`, `/hr/timesheets → /me/timesheets`, `/hr/documents → /me/documents`. No install gates on these redirect stubs — correct, they are gated by employment not app install.

### Cross-reference with `docs/HR_PAYROLL_ARCHITECTURE.md`
Architecture doc lists six apps (`employees`, `time-off`, `attendance`, `timesheets`, `payroll`, `recruitment`). The `timesheets` app is described as owning `/hr/timesheets/*` (admin) but in routes.tsx that path redirects to `/me/timesheets`. The Timesheets sub-app in registry is a separate installable but has **no dedicated sub-route file** under `src/apps/hr/sub/`; timesheet approvals live under the Attendance sub-app surface. **Minor doc drift.**

---

## 2. Payroll Architecture Map

### Key tables (RLS status verified via migrations)

| Table | RLS Enabled | Migration ref |
|---|---|---|
| `payroll_runs` | ✅ | `20260116105854:332` |
| `payslips` | ✅ | `20260116105854:333` |
| `payslip_lines` | ✅ | `20260507115814:77` |
| `payslip_inputs` | ✅ | `20260507115814:98` |
| `payroll_statutory_rules` | ✅ | `20260222093636:18` |
| `payroll_statutory_rates` | ✅ | `20260116105854:334` |
| `payroll_remittances` | ✅ | `20260327013749:31` |
| `payroll_remittance_payments` | ✅ | `20260509235414:151` |
| `payroll_work_entries` | ✅ | `20260505013644:56` |
| `payroll_work_entry_types` | ✅ | `20260510103130:89` |
| `payroll_run_issues` | ✅ | `20260507115814:188` |
| `payroll_run_groups` | ✅ | `20260606143043:63` |
| `payroll_run_loan_skip_overrides` | ✅ | `20260606210937:29` |
| `payroll_remittance_payment_allocations` | ✅ | `20260509235414:152` |
| `pay_schedules` | ✅ | `20260507115814:48` |
| `salary_structures` | ✅ | `20260326174613:129` |
| `salary_structure_rule_sets` | ✅ | `20260510004610:27` |
| `contract_compensation_components` | ✅ | `20260507115814:118` |
| `employee_garnishments` | ✅ | `20260606220757:54` |

### Key Edge Functions

| Function | Exists | Notes |
|---|---|---|
| `compute-payroll` | ✅ | 2,514-line engine; `supabase/functions/compute-payroll/index.ts` |
| `post-payroll-gl` | ✅ | `supabase/functions/post-payroll-gl/` |
| `reverse-payroll` | ✅ | `supabase/functions/reverse-payroll/`; UI calls `compute-payroll` with `run_type:'correction'` (`ReversePayrollDialog.tsx:140`) |
| `generate-payslip-pdf` | ✅ | `supabase/functions/generate-payslip-pdf/` |
| `generate-payroll-document` | ✅ | `supabase/functions/generate-payroll-document/` |
| `generate-tax-certificate` | ✅ | `supabase/functions/generate-tax-certificate/` |
| `publish-localization-pack-version` | ✅ | `supabase/functions/publish-localization-pack-version/` |
| `post-payroll-payment-gl` | ✅ | `supabase/functions/post-payroll-payment-gl/` |
| `download-tax-certificate` | ✅ | `supabase/functions/download-tax-certificate/` |
| `generate-statutory-return` | ✅ | `supabase/functions/generate-statutory-return/` |

### Key RPCs
- `assert_payroll_ready`: called at `compute-payroll/index.ts:505`.
- `record_payment_atomic`: referenced in `src/integrations/supabase/types.ts` (unverified usage site in HR hooks).
- `payroll_apply_proposed_mappings`: present per ADR 0022; trigger `trg_default_account_settings_payroll_role` enforces mapping roles independently (`docs/adr/0022-payroll-mapping-integrity.md`).
- `payroll_generate_reclassification_je`: described in ADR 0022; unverified in migrations scan.
- `lock_timesheets_for_payroll` / `unlock_timesheets_for_payroll`: ✅ `src/hooks/usePayrollPeriods.ts:97,122`.
- `process_leave_accruals`: ✅ `src/integrations/supabase/types.ts:45115`.

### ADRs
- **ADR 0005** (`docs/adr/0005-hr-payroll-split-and-entitlement-architecture.md`): HR split into 5 apps, five-state entitlement matrix, marketplace open, trigger gaps closed. Code matches.
- **ADR 0010** (`docs/adr/0010-localization-pack-versioning-and-tokens.md`): JSON schema enforcement via `trg_assert_pack_payload_valid`, version history, `SchemaForm`-driven editor.
- **ADR 0022** (`docs/adr/0022-payroll-mapping-integrity.md`): Table-tier mapping role guard via `trg_default_account_settings_payroll_role`. Closes GL mis-mapping incident.

---

## 3. Employee Lifecycle Assessment

| Stage | Code Evidence | Gap |
|---|---|---|
| **Recruitment** | `src/pages/hr/Recruitment.tsx` — requisitions, candidates, applications, offers, interview feedback tabs | No `AppInstalledGate` on route (`routes.tsx:52`) |
| **Candidate → Hire** | `useRecruitment` hooks; offer stage in `STAGES` array (`Recruitment.tsx:24`) | No automated employee record creation from offer acceptance; handoff is manual |
| **Contract** | `EmployeeContracts.tsx`, `employee_contracts` table (RLS ✅ `20260225065122:31`), `contract_compensation_components` (RLS ✅) | Contract start/end drives proration in `compute-payroll/index.ts:1447` |
| **Onboarding** | `src/pages/me/MyOnboarding.tsx` mounted at `/me/onboarding` in `MeApp.tsx` | No HR-admin onboarding task assignment UI found in scanned pages |
| **Active** | `EmployeeProfile.tsx`, `EmployeesRoutes.tsx`, contracts, leave, loans, timesheets | Full feature set present |
| **Separation** | `termination_date` on `employees`; `employee_exit_clearance` / `employee_exit_clearance_items` tables (RLS ✅ `20260606143043:128,167`) | |
| **Final payroll** | `compute-payroll` checks exit clearance: `index.ts:627-635`; `termination_date` drives proration `index.ts:1447` | |
| **Exit clearance (self-service)** | `src/pages/me/MyExitClearance.tsx` — read-only view at `/me/exit` | Employee cannot self-clear items (by design); department sign-off is admin-only (no admin UI found) |

**Key gap**: No automated recruitment→employee record promotion.

---

## 4. Payroll Lifecycle Assessment

| Step | Code Path | Notes |
|---|---|---|
| **Config** | `PayrollRoutes.tsx` → `Setup`, `Configuration`, `SalaryStructures`, `Templates`, `WorkEntryTypes`; ADR 0010 schema enforcement | |
| **Period open** | `usePayrollPeriods.ts`; `lock_timesheets_for_payroll` RPC | |
| **Work entries** | `payroll_work_entries` table; `useGenerateAttendanceWorkEntries.ts`; `usePayrollWorkspaceData.ts:43` | Attendance→work-entries via `generate-attendance-work-entries` fn; integration completeness unverified |
| **Compute** | `supabase/functions/compute-payroll/index.ts` (2,514 lines): proration, leave/loan/benefit deductions, statutory rules, dry-run, `assert_payroll_ready:505`, exit clearance gate:627 | |
| **Review** | `PayrollReadiness` section (`sections.tsx`); `useEmployeePayrollReadiness` hook | |
| **Post-GL** | `supabase/functions/post-payroll-gl/` | |
| **Payslip** | `generate-payslip-pdf`, `generate-payroll-document`; `PayslipDetailDialog`; portal view in `EmployeeSelfService.tsx` | |
| **Remittance** | `payroll_remittances`, `payroll_remittance_payments`; `RemittanceTracking.tsx`; `post-remittance-payment` fn | |
| **Certificate** | `generate-tax-certificate`, `download-tax-certificate`; `TaxCertificates` page in `PayrollRoutes` | |
| **Retro / correction** | `run_type: 'correction'` with `parent_run_id`; `ReversePayrollDialog.tsx:140`; `reverse-payroll` fn | |
| **Multi-branch** | `business_id` parameter on `compute-payroll` (`index.ts:45,507`); `payroll_run_groups` table (RLS ✅) | |

---

## 5. Enterprise Readiness Matrix

| Capability | SME | Mid-Market | Enterprise | Multi-Branch |
|---|---|---|---|---|
| Multi-entity (business_id scoping) | ✅ | ✅ | ✅ | ✅ |
| Multi-currency | ⚠️ Org currency only | ⚠️ | ❌ | ❌ |
| Multi-jurisdiction (localization packs) | ✅ | ✅ | ⚠️ Multi-country in one run unverified | ⚠️ |
| Multi-level approvals (leave) | ✅ Two-level (`pending_second_approval`) | ✅ | ⚠️ No configurable N-level | ⚠️ |
| Payroll approval workflow | ⚠️ Compute→post; no maker-checker | ⚠️ | ❌ | ❌ |
| RBAC | ✅ | ✅ | ⚠️ No HR role separation | ⚠️ |
| Audit trail | ⚠️ `timesheet_audit_log` only | ⚠️ | ❌ | ❌ |
| Reporting | ✅ | ✅ | ⚠️ No consolidated payroll register at scale | ⚠️ |
| Integrations | ✅ M-Pesa, Stripe, GL | ✅ | ⚠️ No bureau export | ⚠️ |
| Org chart | ✅ `OrgChart.tsx` | ✅ | ⚠️ Static; no matrix reporting | ⚠️ |

---

## 6. Portal User Boundary Audit

### What `userType === "portal"` can reach

`PORTAL_ALWAYS_ALLOWED` (`PortalUserRoute.tsx` — tightened this turn):
- `/me/*`, `/hr/my-portal`, `/select-organization`, `/settings/profile`, `/settings/notifications`, `/notifications`
- (Removed: blanket `/settings`, `/upgrade`.)

Permission-gated: `/me/leave`, `/me/timesheets`, `/me/documents`, `/me/profile`, `/me/attendance`.

### Settings page bleed (fixed this turn)
**Pre-fix**: `WorkspaceSettings.tsx:197` rendered an unguarded `<Link to="/settings/apps">Apps & Subscriptions</Link>` header button. `/settings/apps` (App.tsx:302) had no portal guard.
**Post-fix**: Link wrapped in `!isPortalUser`; `/settings/apps` and all admin settings routes wrapped in `PortalUserRoute`. `/settings` itself redirects portal users to `/me/settings`.

### MeHome locked tiles
Pre-fix: `MeHome.tsx:66` linked dim tiles to `/apps/{id}/activate` (bounced for portal users — confusing UX).
Post-fix: Tiles for ungranted apps are hidden via `useVisibleActions()`.

### Outstanding portal bleed audits
- `NotificationBell` / `NotificationPopover` cross-link audit — not yet scanned.
- `UserProfileSheet` (header avatar menu) — not yet scanned.
- Server-side portal deny on apps-install / subscription mutation RPCs — UI now blocks, server enforcement unverified.

---

## 7. Timesheets Surface Audit

### Route locations

| Page | Route | Shell |
|---|---|---|
| `MyTimesheets.tsx` | `/me/timesheets` (via `MeApp.tsx`) | PortalLayout |
| `TeamTimesheets.tsx` | Admin surface | DashboardLayout |
| `TimesheetApprovals.tsx` | Admin surface | DashboardLayout |
| `TimesheetReports.tsx` | Admin surface | DashboardLayout |
| `TimesheetSettings.tsx` | Admin surface | DashboardLayout |
| `Timesheets.tsx` | Thin wrapper: re-exports `MyTimesheets` | DEAD CODE |
| `ByProject.tsx` | Admin / manager surface | DashboardLayout |

### Employee vs Admin
`MyTimesheets.tsx` scoped via `useCurrentEmployee()`; no admin affordances inline.
`TeamTimesheets.tsx:20` gates on `canApproveTimesheets || canViewTeamTimesheets || isManager`. Separation is **correct in code**, but the docs/HR_PAYROLL_ARCHITECTURE description of a distinct `timesheets` admin sub-app with `/hr/timesheets/*` routes is stale.

### Timesheets → payroll_work_entries handoff
`usePayrollWorkspaceData.ts:43` reads `payroll_work_entries`.
`useGenerateAttendanceWorkEntries.ts` invokes SECURITY DEFINER RPC to generate entries.
`usePayrollPeriods.ts:97,122` provides `lock_timesheets_for_payroll` / `unlock_timesheets_for_payroll`.
`types.ts:37808` `timesheets.payroll_period_id` FK.
**Chain present**; per-type fidelity unverified.

---

## 8. Verified vs Claimed Table

| Claim | Status | Evidence |
|---|---|---|
| `acknowledge_employee_document` RPC | ✅ Verified | `MyDocuments.tsx:7`; `useMyDocuments` hook |
| `MyDocuments` page at `/me/documents` | ✅ Verified | `MyDocuments.tsx`; `MeApp.tsx` route |
| `MyExitClearance` at `/me/exit` | ✅ Verified | `MyExitClearance.tsx`; `MeApp.tsx` |
| `SELF_SERVICE_FIELDS` widened in `EmployeeProfile.tsx` | ✅ Verified | `EmployeeProfile.tsx:56` — 8 fields |
| `/me/expenses` removed from `MeApp` | ✅ Verified | Not in `MeApp.tsx` |
| Exit-clearance gate in `compute-payroll` | ✅ Verified | `compute-payroll/index.ts:627-635` |
| `attachSupabaseAuth` wired in `src/start.ts` | ❌ Missing | `src/start.ts` does not exist; `auth-attacher.ts:5` requires registration there |
| Portal users blocked from `/hr/*` | ✅ Verified | `internalOnly: true` on all HR app defs (`registry.ts:80,114,146…`); `InternalOnlyRoute` |
| Portal users cannot reach `/settings/apps` | ❌ → ✅ (fixed this turn) | Pre-fix: unguarded `Link` + unguarded route; Post-fix: wrapped in `PortalUserRoute` and link hidden |
| Recruitment wrapped in `AppInstalledGate` | ❌ Missing | `routes.tsx:52`: no gate |
| Two-level leave approval | ✅ Verified | `LeaveApprovalDialog.tsx:57`, `LeaveTypeSettingsDialog.tsx:48-49`, `pending_second_approval` |
| Leave accrual scheduler | ⚠️ Partial | RPC exists (`types.ts:45115`); no cron/edge fn invokes it |
| Payroll mapping integrity (ADR 0022) | ✅ Verified | `trg_default_account_settings_payroll_role`; `payroll_apply_proposed_mappings` |
| Multi-branch payroll via `business_id` | ✅ Verified | `compute-payroll/index.ts:45,507,592` |
| `payroll_run_groups` table with RLS | ✅ Verified | `20260606143043:63` |
| Correction / retro runs | ✅ Verified | `ReversePayrollDialog.tsx:140`; `reverse-payroll` fn |

---

## 9. Critical Gaps

### Critical
1. ~~**Portal user can reach `/settings/apps`**~~ — **fixed this turn** (link hidden + route wrapped).
2. **`attachSupabaseAuth` not wired** — `src/start.ts` missing; router-layer Supabase fetches may not propagate auth headers. Unverified impact on HR/Payroll loaders.

### High
3. **Recruitment has no `AppInstalledGate`** (`routes.tsx:52`).
4. **Leave accrual scheduler gap** — no cron invokes `process_leave_accruals`.
5. **No payroll maker-checker step** — single user with `managePayroll` can compute AND post.

### Medium
6. **MeHome dimmed tiles** ~~link to `/apps/{id}/activate`~~ — **fixed this turn** (hidden).
7. **Recruitment → Employee promotion not automated**.
8. **No unified HR audit log** — only `timesheet_audit_log` exists.
9. **Admin onboarding task assignment UI unverified**.

### Low
10. **`Timesheets.tsx` is a thin no-op wrapper** — safe to remove.
11. **Doc drift**: architecture doc lists `timesheets` as a distinct admin sub-app.

---

## 10. Missing Features

| Feature | Notes |
|---|---|
| Per-payslip multi-currency FX | Org currency only |
| Configurable N-level approval chains | Leave has 2-level; payroll has none |
| Payroll run maker-checker (draft → approve → post) | SOX compliance |
| Country-specific bureau / BACS file export | Bank file exists; bureau format unverified |
| Employee self-service expense claims | `/me/expenses` removed; no replacement |
| Department-level exit clearance admin UI | Table exists; no admin page |
| Headcount / attrition analytics dashboard | `HRReports.tsx` exists; depth unverified |
| HR RBAC role separation (HR Admin / Payroll Admin / Manager) | Permission flags only |
| Automated recruitment → employee promotion | Manual |
| Leave accrual automated scheduler | RPC exists; no cron |
| P60 / P45 / country-specific termination docs | Unverified |

---

## 11. Duplicate Logic

| Duplication | Locations | Risk |
|---|---|---|
| Payroll computation | `src/lib/payroll/computationMethods.ts` (client) vs `supabase/functions/compute-payroll/index.ts` (server) | Preview/server divergence |
| Leave accrual | `src/hooks/leave/useLeaveAccruals.ts` (client) vs `process_leave_accruals` RPC | Rounding/frequency disagreement |
| Reverse payroll | `reverse-payroll` edge fn + `compute-payroll` correction run | Unclear authority |

---

## 12. Architectural Risks

### RLS
All 19 scanned HR/Payroll tables have RLS enabled. Policy content (which roles/conditions) not audited in this pass.

### Race Conditions
- `compute-payroll` + `post-payroll-gl` separate invocations; no distributed lock. Concurrent re-run during posting could duplicate JEs.
- Loan deductions: retry after timeout could double-deduct before rollback.

### Circular Dependencies
- `PayrollRoutes.tsx` lazy-imports many named exports from `sections.tsx` — fragile pattern if `sections.tsx` ever back-imports.

### Dead Code
- `src/pages/timesheets/Timesheets.tsx` — pure re-export wrapper.
- Deprecated `HR_APP` alias (per ADR 0005) — unverified.

### `attachSupabaseAuth` not wired
`auth-attacher.ts:5` mandates `src/start.ts`; file missing. Possible silent 401→empty-data behavior on TanStack router fetches.

---

## 13. Recommended Roadmap

| Priority | Item | Effort |
|---|---|---|
| **P0 (done)** | Portal bleed fix on `/settings/apps` + Apps&Subs header link | XS |
| **P0** | Wire `attachSupabaseAuth` in `src/start.ts` or confirm not needed | S |
| **P1** | Add `AppInstalledGate appId="recruitment"` to `routes.tsx:52` | XS |
| **P1** | Leave accrual cron: scheduled edge fn invoking `process_leave_accruals` daily | S |
| **P1** | Payroll maker-checker: add `draft` status to `payroll_runs`; require second approver before `post-payroll-gl` | L |
| **P2 (done)** | MeHome dimmed tile link → hidden | S |
| **P2** | Unify reverse-payroll: deprecate `reverse-payroll` edge fn | M |
| **P2** | Resolve client `computationMethods.ts` vs edge divergence | M |
| **P3** | Recruitment → Employee promotion action | M |
| **P3** | Department exit clearance admin UI | M |
| **P3** | Unified HR audit log table | L |
| **P4** | Multi-currency payroll: per-run FX rate capture | XL |
| **P4** | N-level configurable approval chains (generic engine) | XL |
| **P4** | Remove `Timesheets.tsx` dead wrapper; fix doc drift | XS |

---

*Audit completed against codebase state as of 2026-06-07. Migrations scanned: 1,205. Edge functions: 80+. HR/Payroll tables with RLS verified: 19/19 targeted. Active issues at audit time: 2 Critical, 3 High, 4 Medium, 2 Low. After this turn's fixes: 1 Critical, 3 High, 3 Medium, 2 Low.*
