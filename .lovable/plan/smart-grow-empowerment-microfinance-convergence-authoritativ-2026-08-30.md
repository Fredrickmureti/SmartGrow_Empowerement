# Smart Grow Empowerment — Microfinance Convergence (authoritative plan)

Single source of truth. Read this first, execute the next migration in order, do
not reopen closed ones, do not start new investigations.

## What we are building

One microfinance institution (ASA branch model), internal and employee-operated.
Converged from the inherited AccrualFlow ERP platform through controlled
migrations — never a rewrite.

Permanently out of scope (never re-add, never ask): SaaS / tenants /
subscriptions / entitlements / platform admin, payroll, attendance, timesheets,
time-off, POS, inventory, warehouse, procurement, sales order-to-cash, client
portal, public registration, hardware/device estate.

Keep and reuse: PIN + auth, app shell and navigation, RBAC (`user_roles` +
`has_role`), company/branch settings, chart of accounts, journals, GL, fiscal
periods, banking + reconciliation, fixed assets, FX resolver, report engine,
document engine, audit, storage, business-event/saga infrastructure.

## Working rules (non-negotiable)

1. One migration at a time: scope → dependency graph → code change → DB change →
   typecheck + build + affected screens → append report here → stop for review.
2. Removal order is always dependency graph → code removal → schema drop. Never
   drop a table before its readers are gone.
3. All financial state derived server-side. React never owns balances, interest,
   arrears, allocations, or journal amounts.
4. Every domain action is a business event with an accounting hook, never a CRUD
   update. Account mappings are configuration — no account UUIDs in domain code.
5. New public tables always get GRANTs + RLS + policies in the same migration.
6. Inherited ERP rows are not this institution's data. No microfinance surface
   reads legacy invoices, bills, POS, payroll, CRM, or inventory rows.
7. Test suite may never regress; each migration must reduce failing files.

## Handover verification (2026-08-30, this session)

Claims from the previous engineer were checked directly against the codebase,
not accepted:

- M0 (manifest prune, preview 500 fix) — consistent with the tree. ACCEPTED.
- M3b code half — CONFIRMED: `SubscriptionAccessContext`, `usePlatformPermissions`,
  `useAdminNotifications`, `CountryWorkspaceContext`, `lib/command/surface.ts`
  are gone; `src/hooks/useActionGate.ts` exists. Only comment-level mentions of
  "entitlement"/"subscription" remain. ACCEPTED.
- M3b DB half — platform authority neutralised, `platform_admins` retained as an
  empty view. ACCEPTED, with a carry-forward: `SignupForm.tsx`,
  `EmployeeLinkDialog.tsx` and several architecture tests still reason about a
  platform-admin persona. Now tracked as M7 work rather than "done".
- M4 — NOT started: `src/services/hardware/` (20+ modules) and
  `src/hooks/hardware/` (5 hooks) are fully present and still imported by
  `src/services/printing/*`.

Verdict: resume at M4, with the platform-persona remnants added to M7.

## Status board

| Migration | Scope | Status |
| --- | --- | --- |
| M0 | Test-suite re-baseline, prune stale manifests | DONE |
| M3b | SaaS / plan / entitlement / platform-admin de-scope | DONE |
| M4 | Decouple printing from hardware, delete hardware layer | DONE (code + DB retirement) |
| **M5** | **Retire payroll, attendance, non-actor HR from schema** | **ACTIVE** |
| M6 | Institution identity & settings as single config root | queued |
| M7 | RBAC roles, PIN auth, navigation IA, retire SaaS remnants | queued |
| M8 | Finance foundation + microfinance account-mapping registry | queued |
| M9 | Clients & groups (ASA model) | queued |
| M10 | Loan products (immutable versions) | queued |
| M11 | Applications, assessment, approval | queued |
| M12 | Loan, server-side schedule engine, disbursement | queued |
| M13 | Payments, allocation, arrears/DPD/PAR, collections | queued |
| M14 | Top-up, restructuring, write-off, closure | queued |
| M15 | Reporting & documents on the existing engines | queued |
| M16 | Audit, RLS/grants, security hardening, arch suite green | queued |

Baseline to beat: typecheck clean, build OK, vitest 31 failed / 301 passed files.

## M4 — DONE

Code decoupling completed earlier. Database retirement completed 2026-08-30 in
four single-purpose migrations:
1. label subsystem (`label_templates`, `label_demand`, `label_print_runs`,
   `label_print_run_lines`, all `*label*` functions, 6 label enum types,
   `purge-label-run-lines-nightly`);
2. `print_jobs.hw_command_id` dropped; `print_job_mark_sent(uuid)` and
   `print_jobs_settle(uuid[])` re-created without the hardware argument;
   `print_job_mark_acked` / `mark_print_job_dispatched` dropped;
3. hardware relay (`hardware_command_queue`, `hardware_exec_log`, its
   functions, `hardware_command_status`, `cleanup-hardware-exec-log-daily`);
4. device registry (`device_assignments`, `device_workflow_bindings`,
   `printer_roles`, `scanner_device_trust`, `scanner_device_labels`, resolver
   functions) plus `resolve_output_intent` rewritten PDF-only.

Deferred by design: `attendance_devices`, `attendance_device_trust`,
`employee_device_identifiers`, `user_devices`, `fiscal_device_credentials`,
`workstations` — owned by M5 (HR/attendance) and the POS retirement milestone.
`wms_equipment_health` / `wms_detect_operational_exceptions` still name dropped
tables; they die with the WMS retirement.

Verification: `tsgo -p tsconfig.app.json` clean; printing + printing-architecture
suites 9 files / 50 tests green.

## M4 — original scope (historical)

Printing is needed for M15 documents; the device estate (ESC/POS drivers, local
agents, label printers, device assignments) belongs to POS/warehouse.

Verified coupling: `src/services/printing/{types,mediaGeometry,dispatch,policy,
jobs,recovery,reprintClient,PrintService}.ts`, `hooks/printing/usePrintWithFallback.ts`,
`components/printing/PrintRecoveryMount.tsx`, `components/common/PrintPreviewDialog.tsx`,
`hooks/hardware/*`, `hooks/useDeviceAssignments.ts`, `services/events/BusinessSaga.ts`,
`services/documents/{submitIntent,outputIntent}.ts`, `apps/platform/nav.ts`,
`components/layout/AppSidebar.tsx`, `pages/settings/CompanySettings.tsx`,
`pages/Downloads.tsx`, `types/global.d.ts`, `types/electron.d.ts`.

Order of work:
1. Own the geometry/envelope/media types printing needs inside
   `src/services/printing/`; no hardware imports.
2. Repoint dispatch at a plain browser/server path (PDF → viewer →
   `window.print`); drop intent/device resolution and the saga's device hooks.
3. Delete `src/services/hardware/`, `src/hooks/hardware/`, `useDeviceAssignments`,
   their nav entries, settings sections, routes, ambient declarations, and the
   hardware architecture tests.
4. Only then drop the schema: `device_assignments`, `device_workflow_bindings`,
   printer/print-job/label tables and enums (`hardware_command_status`,
   `print_job_status`, `printer_workflow`, `label_*`). `attendance_devices`
   defers to M5.
5. Verify: typecheck, build, a real document preview/print from a finance
   screen, suite ≤ 31 failing files.

## M5 — payroll, attendance, non-actor HR

Largest removal; one migration per cohesive group, dependency graph first:
payroll runs/periods/rules/inputs/payslips/returns/certificates/bank exports
(~54 tables) → the employee-advance "loan" tables (`employee_loans`,
`loan_types`, `loan_repayment_schedule`, `loan_repayments`,
`loan_lifecycle_events` — NOT lending, never reuse) → attendance, breaks,
devices, events, ingest → compensation history, contracts, benefits, onboarding,
competencies, exit clearance, statutory identifiers. Keep only what makes an
employee a system actor: identity, role, branch assignment, loan-officer
assignment, audit; retain cheap scale attributes (position, department,
location).

## M7 additions from this verification

- Retire `src/pages/AcceptOwnership.tsx` and its route (SaaS ownership transfer).
- Remove the platform-admin persona branch in `components/auth/SignupForm.tsx`
  and the classification path in `components/employees/EmployeeLinkDialog.tsx`.
- Rewrite architecture tests that assert `is_platform_admin` /
  `platform_admins` (`currency-ratchet`, `no-direct-employee-user-link`,
  `governance-action-registry-parity`) against the RBAC model that survives.
- Decide retire-vs-reown for `useDemoVideos` / `ResourceCenterLauncher` write
  paths (M6 if kept as institution content, M7 if retired).

## Microfinance domain target (M8–M16)

Account-mapping registry (principal receivable, interest income/receivable, fee
income, penalty income, cash, bank, mobile money, write-off expense) → clients &
groups with KYC, branch, owning officer, meeting slot (group membership never
implies joint liability) → versioned loan products → staff-created applications
with recorded assessment visit and branch-level approval within authority limits
(approval ≠ disbursement) → loan snapshot + server-side schedule engine +
idempotent disbursement event → batch-per-meeting repayments with per-member
receipts, configurable allocation order, reversals, derived arrears/DPD/PAR,
officer-scoped collections → top-up/restructure/write-off/closure as
event-sourced processes with derived cycle graduation → portfolio, collections,
arrears and client reports plus loan agreement, schedule, statement, receipt and
disbursement documents on the existing engines → RLS, grants, audit, hardening.

## Report format (append below, newest last)

Migration · Objective · Changed · Preserved · Removed · Adapted · Database ·
Dependencies · Verification · Result (PASS/FAIL/BLOCKED) · Next.

## Currently active

**M4 — printing/hardware decoupling.** Nothing else. No loan-domain work until
M4 and M5 are closed and verified.
