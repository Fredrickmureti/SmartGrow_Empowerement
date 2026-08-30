# Smart Grow Empowerment — Microfinance Convergence (authoritative handover)

Read this file first. It is the single source of truth for what is done, what is
next, and the exact rules. Do not re-audit closed migrations. Do not re-derive
scope. Do not open new investigations — execute the next migration in order.

Full historical detail: `.lovable/plan/smart-grow-empowerment-microfinance-convergence-authoritativ-2026-08-30.md`.

## What we are building

One microfinance institution (ASA branch model). Internal, employee-operated.
Converged from the inherited AccrualFlow ERP platform by controlled migrations —
never a rewrite. Keep and build on the proven infrastructure; delete only what
the institution will never use.

Permanently out of scope (never re-add, never ask about):
SaaS / tenants / subscriptions / plans / entitlements / platform admin, payroll,
attendance, timesheets, time-off, POS, inventory, warehouse, procurement,
sales order-to-cash, client portal, public registration.

Keep and reuse: PIN + auth, app shell and navigation, RBAC (`user_roles` +
`has_role`), company/branch settings, chart of accounts, journals, GL, fiscal
periods, banking + reconciliation, fixed assets, FX resolver, report engine,
document engine, audit, storage, business-event/saga infrastructure.

## Working rules (non-negotiable)

1. One migration at a time: scope → dependency graph → code change → DB change →
   `bunx tsgo -p tsconfig.app.json --noEmit` + build + affected screens →
   append report to this file → stop for review.
2. Removal order is always dependency graph → code removal → schema drop. Never
   drop a table before its readers are gone.
3. All financial state derived server-side. React never owns balances, interest,
   arrears, allocations, or journal amounts.
4. Every domain action is a business event with an accounting hook, never a CRUD
   update. Account mappings are configuration — no account UUIDs in domain code.
5. New public tables always get GRANTs + RLS + policies in the same migration.
6. Inherited ERP rows are not this institution's data. No microfinance surface
   reads legacy invoices, bills, POS, payroll, CRM, or inventory rows.

## Status board

| Migration | Scope | Status |
| --- | --- | --- |
| M0 | Test-suite re-baseline, prune stale manifests | DONE 2026-08-30 |
| M3b | SaaS / plan / entitlement / platform-admin de-scope (code + DB) | DONE 2026-08-30 |
| **M4** | **Decouple printing from hardware, delete hardware layer** | **NEXT — start here** |
| M5 | Retire payroll, attendance, non-actor HR from schema | queued |
| M6 | Institution identity & settings as single config root | queued |
| M7 | RBAC roles, PIN auth, navigation IA, retire SaaS remnant routes | queued |
| M8 | Finance foundation + microfinance account-mapping registry | queued |
| M9 | Clients & groups (ASA model) | queued |
| M10 | Loan products (immutable versions) | queued |
| M11 | Applications, assessment, approval | queued |
| M12 | Loan, server-side schedule engine, disbursement | queued |
| M13 | Payments, allocation, arrears/DPD/PAR, collections | queued |
| M14 | Top-up, restructuring, write-off, closure | queued |
| M15 | Reporting & documents on the existing engines | queued |
| M16 | Audit, RLS/grants, security hardening, arch suite green | queued |

Verified baseline as of 2026-08-30 after M3b: typecheck clean, build OK, vitest
**31 failed / 301 passed files (52 failing tests)**. Never let this get worse;
every migration must reduce it. Failures are already mapped to owning migrations
in the M0 report of the archived plan — do not re-triage them from scratch.

## Done — do not redo

**M0.** Removed 39 manifests describing deleted/out-of-scope code (payroll, POS,
inventory, WMS, localization packs, hardware scope, HR autosave); pruned 6 mixed
manifests. Fixed a preview HTTP 500 caused by a stale Vite cache /
`@tanstack/router-core` mismatch. Baseline 52 → 32 failing files.

**M3b, code half.** Subscription/plan/entitlement/trial state removed from
`SessionContext.tsx`, `lib/apps/registry.ts`, `lib/apps/types.ts`,
`hooks/useAppNavigation.ts`, `useAppAccess.ts`, command palette, app cards.
`useEntitlementGate` → `src/hooks/useActionGate.ts` (gates on app existence /
installed / coming-soon / setup only; RBAC stays server-authoritative). Deleted
`SubscriptionAccessContext`, `usePlatformPermissions`, `useAdminNotifications`,
`CountryWorkspaceContext`, `lib/command/surface.ts`. `isPlatform` →
`alwaysAvailable`; registry group "Platform" → "System".

**M3b, DB half.** Platform authority permanently neutralised: `is_platform_admin`,
`_user_is_active_platform_admin`, `has_platform_permission` return false;
role → null; permissions/scopes → empty. `get_user_session_data` rewritten with
no platform read and no plan-shaped keys. Dropped the SaaS admin subsystem
(admin groups/members/permissions/country scopes/sessions/alerts/notifications,
ownership transfers, permission definitions, automation rules, platform email
tables, feature catalog, demo requests, `platform_admin_role`, ownership-transfer
routines). `public.platform_admins` is now a permanently empty `security_invoker`
view, deliberately keeping ~103 legacy policies syntactically valid while making
platform authority unreachable. Retained real infrastructure:
`platform_settings`, `platform_apps`, `platform_bank_providers`,
`platform_integration_*`, `platform_exchange_rates`, `platform_demo_videos`.

## M4 — NEXT: decouple printing from hardware, then delete the hardware layer

Why now: document printing is required by M15, and the hardware/device estate
(ESC/POS drivers, local agents, label printers, device assignments) belongs to
POS/warehouse, not microfinance. It also still drags nav/settings surfaces.

Exact coupling to resolve (verified 2026-08-30):
- `src/services/printing/{types.ts,mediaGeometry.ts,dispatch.ts}` import from
  `src/services/hardware/*`.
- `src/hooks/printing/usePrintWithFallback.ts`,
  `src/components/printing/PrintRecoveryMount.tsx`,
  `src/components/common/PrintPreviewDialog.tsx` reach into hardware.
- `src/hooks/hardware/*` (5 hooks), `src/hooks/useDeviceAssignments.ts`.
- `src/services/events/BusinessSaga.ts`, `src/apps/platform/nav.ts`,
  `src/components/layout/AppSidebar.tsx`, `src/pages/settings/CompanySettings.tsx`,
  `src/pages/Downloads.tsx`, `src/types/global.d.ts` reference hardware/printer.

Order of work:
1. Move the geometry/envelope/media types that printing genuinely needs into
   `src/services/printing/` (own them locally, no hardware import).
2. Repoint `dispatch.ts` at a plain browser/server print path (PDF → viewer →
   `window.print`); drop intent/device resolution.
3. Delete `src/services/hardware/`, `src/hooks/hardware/`,
   `useDeviceAssignments`, and their nav entries, settings sections, routes,
   `global.d.ts` declarations, and remaining hardware architecture tests.
4. Drop the device/printer/label schema in a migration only after step 3:
   `device_assignments`, `device_workflow_bindings`, `attendance_devices` (defer
   to M5 if it is attendance-owned), printer/print-job/label tables and their
   enums (`hardware_command_status`, `print_job_status`, `printer_workflow`,
   `label_*`).
5. Verify: typecheck, build, a document preview/print from an existing finance
   screen, suite ≤ 31 failing files.

## M5 — then: retire payroll, attendance, non-actor HR from the schema

Largest removal; one migration per cohesive group, dependency graph first.
Groups: payroll runs/periods/rules/inputs/payslips/returns/certificates/bank
export files (~54 tables) → the employee-advance "loan" tables
(`employee_loans`, `loan_types`, `loan_repayment_schedule`, `loan_repayments`,
`loan_lifecycle_events` — these are NOT lending, never reuse them) → attendance,
breaks, devices, events, ingest → employee compensation history, contracts,
benefits, onboarding, competencies, exit clearance, statutory identifiers.
Keep only what makes an employee a system actor: identity, role, branch
assignment, loan-officer assignment, audit. Retain cheap future-scale attributes
(position, department, location). Also removes the legacy `platform_admins`-shaped
payroll functions carried forward from M3b.

## Carry-forward items with owners

- `src/pages/AcceptOwnership.tsx` + route — SaaS ownership transfer, retire in M7.
- `useDemoVideos` / `ResourceCenterLauncher` write paths lost their admin policy —
  decide retire-vs-reown in M6.
- Legacy functions still naming the empty `platform_admins` view resolve to false;
  they die with their domains in M5/M7.

## Microfinance domain target (M8–M16, unchanged)

Account-mapping registry (principal receivable, interest income/receivable, fee
income, penalty income, cash, bank, mobile money, write-off expense) → clients &
groups with KYC, branch, owning officer, meeting slot (group membership never
implies joint liability) → versioned loan products → staff-created applications
with recorded assessment visit and branch-level approval within authority limits
(approval ≠ disbursement) → loan snapshot + server-side schedule engine +
idempotent disbursement event → batch-per-meeting repayments with per-member
receipts, configurable allocation order, reversals, derived arrears/DPD/PAR,
officer-scoped collections → top-up/restructure/write-off/closure as event-sourced
processes with derived cycle graduation → portfolio/collections/arrears/client
reports and loan agreement, schedule, statement, receipt, disbursement documents
on the existing engines → RLS, grants, audit, hardening.

## Per-migration report format (append below, newest last)

Migration · Objective · Changed · Preserved · Removed · Adapted · Database ·
Dependencies · Verification · Result (PASS/FAIL/BLOCKED) · Next.

## Currently active

**M4 — printing/hardware decoupling.** Nothing else. No loan-domain work until
M4 and M5 are closed and verified.
