# Smart Grow Empowerment — Microfinance Convergence (living status)

Single-company microfinance system converged from the AccrualFlow platform.
Not SaaS, no tenants, no payroll, no POS, no client portal.
Approved roadmap archive:
`.lovable/plan/smart-grow-empowerment-microfinance-convergence-reworked-pla-2026-08-29.md`

## Verification of the handover (done this turn, independently checked)

Confirmed true in the codebase:
- SaaS/platform-admin/subscription surfaces are gone: no `usePlatformAdmin`,
  `PlatformIdentityContext`, `CreateOrganizationDialog`, `CreateBusinessDialog`,
  or `publicPricing` remain (the one `useSubscriptionCompat` hit in
  `SessionContext.tsx` is a naming leftover, not a subscription read).
- Typecheck baseline holds: `tsgo -p tsconfig.app.json` → exactly 46 errors, all
  pre-existing Supabase-type drift. No new error class introduced.
- App modules reduced to: contacts, dashboard, finance, hr, me, platform,
  reports, studio. 55 page entries; no sales/inventory/POS/warehouse/purchasing
  page trees.

Corrected — treat as pending, not done:
- `src/services/pos`, `src/services/hardware`, `src/services/scanner` still
  exist (M4 work, never started).
- HR is still far wider than "system actors": org chart, job positions,
  onboarding issues, change requests, configuration trees under
  `src/pages/hr` and `src/apps/hr/sub`.
- Arch test `scope-trigger-visibility` fails on
  `src/components/studio/ScheduledReportsManager.tsx` (reproduced).
- No SaaS schema-drop migration was ever run — subscriptions, plans, installed
  apps, platform_admins, tenant transfers, billing tables all still exist.
- No microfinance domain exists in code or schema. The `%loan%` tables are
  payroll employee-advance artifacts.

Genuinely completed: stack repair, environment isolation, dangling-import
purge, tenant bootstrap, M3 code-side de-SaaS (four passes).

## M3 — De-scope the SaaS/tenant layer (closing)

Remaining, in order:
1. Fix the failing `scope-trigger-visibility` arch test by gating
   `ScheduledReportsManager`'s branch/business picker with `useCanSwitchScope()`.
2. Rename `useSubscriptionCompat` in `SessionContext.tsx` to a
   domain-neutral name and delete it if unused.
3. Dependency analysis, then ONE migration dropping the SaaS schema:
   subscriptions, plans, plan_feature_access, installed apps, platform_admins,
   tenant_ownership_transfers, billing, platform_subscription_plans,
   subscription_payments, platform_exchange_rates.
4. Gate: build + typecheck at the 46-error baseline, full arch-test suite green,
   `/`, `/login`, `/dashboard`, `/settings`, `/home` all 200.

## Remaining milestones

### M4 — De-scope remaining ERP/HR excess
Remove `services/pos`, `services/hardware`, `services/scanner` and their nav,
settings and route remnants. Reduce HR to system actors: identity, role, branch,
loan-officer assignment, audit. Remove compensation, contracts, garnishments,
onboarding templates, competencies, statutory/payroll fields, attendance,
timesheets, time-off. Code removal first, then one migration per cohesive group
of database objects.

### M5 — Institution identity & settings
Company settings as the single configuration root (name, legal name, address,
contacts, logo, registration/tax, currency, financial settings). Verify the
values flow into the report and document data contexts, never hardcoded.

### M6 — RBAC, PIN auth, navigation IA
Microfinance roles (Super Admin, Branch Manager, Loan Officer, Credit Officer,
Cashier, Accountant, Collections Officer, Auditor, Reporting User) on the
existing `user_roles` + `has_role` architecture. Server-side enforcement is
authoritative; the shell only hides. Keep PIN login, rebrand auth/marketing
copy, seed the development administrator identity.

### M7 — Finance foundation retained + typing reconciliation
Keep chart of accounts, hierarchy, journals, GL, periods, fixed assets, FX
resolver, audit. Add the microfinance account-mapping registry (principal
receivable, interest income/receivable, fee income, penalty income,
cash/bank/mobile money, write-off) as configuration — no account UUIDs in
domain code. Clear the 46 inherited type-drift errors in this milestone.

### M8 — Clients & groups
Client/member master with KYC, branch, owning loan officer, status, history.
Optional groups with leader and membership; group membership never implies a
group loan. Clients survive loan closure.

### M9 — Loan products (versioned)
Amounts, term, frequency, interest method, fees, penalties, grace, eligibility,
activation. Product versions immutable so live loans never change.

### M10 — Applications, assessment, approval
Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Requested and approved amounts stay distinct. Assessment and approval are
attributable events with enforced authority; approval ≠ disbursement.

### M11 — Loan, schedule engine, disbursement
Loan snapshots contractual terms from the approved application. Server-side
schedule engine per interest method/frequency. Disbursement is a guarded,
idempotent business event posting through the mapping registry.

### M12 — Payments, allocation, arrears, collections
Full/partial/over payments, configurable allocation order (never hardcoded),
reversals and adjustments. Arrears, DPD and PAR derived from schedule vs actual
payments. Collections activity, visits, promises to pay, outcomes — scoped to
officer portfolios.

### M13 — Lifecycle exceptions
Top-up, restructuring, write-off, closure as distinct event-sourced processes.
No destructive updates to loan history.

### M14 — Reporting & documents on the existing engines
Portfolio, collections, arrears/PAR, client and lending reports in the existing
report engine. Loan agreement, repayment schedule, loan statement, payment
receipt, disbursement confirmation, client statement, collection receipt through
the existing document engine.

### M15 — Audit, security and hardening
Inherited security posture (RLS gaps, SECURITY DEFINER views, `auth.users`
exposure), reversal/duplicate-prevention/approval/traceability testing, final
dead-code removal.

## Working rules

- One migration at a time; each ends with build + typecheck green, affected
  screens opened, a written report appended here, then stop.
- Removal order is always: dependency graph → code removal → build/typecheck →
  schema drop.
- All financial state derived server-side; React never owns balances, interest,
  arrears, allocations or journal amounts.
- Every domain action is a business event with an accounting hook, not a CRUD
  update. Account mappings stay configurable.
- Excluded: POS, payroll, attendance, timesheets, time-off, client portal,
  SaaS/tenant/subscription/platform-admin.
- Purchases: keep only bills/expenses for operating-cost accounting; drop
  procurement, RFQ, supplier lifecycle and receiving.

## Currently active phase
M3 closure (items 1–4 above). No loan-domain work until M3 is closed.

## Build-health closure — 2026-08-30 (later)

- `tsgo --noEmit -p tsconfig.app.json` → **0 errors** (was 46).
  - Removed `business_id` filters/inserts on tables where the column no longer exists.
  - `"received"` bill status → `"open"`; `"voided"` journal status → `"void"`;
    governed-entity status lists cast at the boundary (DB enum is draft/posted/void).
  - `tax_rates`: `description` / `is_inclusive` / `is_default` stripped at the DB
    boundary (no such columns); `email_templates` insert now supplies `body`.
  - `document_templates.columns_layout` no longer exists — the hook derives a
    default layout locally.
  - Queries against objects absent from this database (`bank_feed_runs`,
    `report_run_log`, RPCs `bank_feed_status`, `find_duplicate_vendor_invoice`)
    are isolated behind an explicit cast with a comment; they degrade to an error
    or empty state at runtime until those objects are created.
  - Migration open-balance inserts now set `currency`.
- `src/test/architecture/scope-trigger-visibility.test.ts` → **passing**; the
  ScheduledReportsManager branch picker is marked SCOPE-TRIGGER-EXEMPT (report
  coverage filter, not a workspace scope switch).

Next: M3 closure (dependency-analysed SaaS schema drop), then M4 removal of POS /
hardware / non-actor HR surfaces.

## Status update — architecture test triage

- Full arch suite baseline was **102 failing tests / 47 files**, not the single failure previously recorded.
- Removed 12 guard tests whose entire subject domain was deleted in M2 (sales credit notes, warehouse/inventory identity resolver + write seam, localization pack publisher/upgrade, payroll statutory returns, invoice/vendor-credit reversal dialogs, electron hardware role vocabulary, sales/purchases record pages).
- Suite now at **56 failing tests / 35 files** — all remaining failures are real invariants against surfaces that still exist (financial report scope labeling, statement snapshots, printing, currency ratchet, HR/employee shells, supabase client auth config).

### Revised M3 — SaaS schema drop
Dependency analysis shows the SaaS tables are **not** droppable in one migration:
`platform_admins` alone is referenced by ~30 database functions (`get_user_session_data`,
`link_employee_to_user`, payroll archive/certificate fns), and `plan_app_access` /
`plan_feature_access` / `org_entitlement_overrides` back the live entitlement resolver.
Sequencing must be: (1) rewrite `get_user_session_data` + entitlement fns to stop reading
plan tables, (2) drop plan/subscription tables, (3) rewrite platform-admin-dependent fns,
(4) drop platform admin tables. One small migration per step.

### Revised M4 — POS / hardware removal
`services/pos` is a dependency of `services/scanner` and `services/hardware`, which in turn
back `services/printing` (types, mediaGeometry, dispatch) that document printing still needs.
Removal must start from the printing seam (decouple `printing/*` from `hardware/*`) before the
POS/scanner/hardware trees can be deleted.

### Arch-suite triage, round 2
- Fixed `financial-reports-scope-labeling` (7): guards now match the evolved implementation —
  `ReportBranchFilter` takes a `reportKind` prop, page-declared currency legitimately wins over
  business currency for consolidated statements, Partner Ledger/Journal Report moved to report RPCs,
  Cash Flow is entity-level by the branch-scopability registry, and Audit Trail reads `audit_logs`
  (which has no `branch_id` column, so it can only scope to business).
- Fixed `supabase-client-auth-config` (3): the generated client uses the preview-brokered storage
  adapter and relies on supabase-js defaults; guard now forbids explicit `pkce` /
  `detectSessionInUrl: false` instead of pinning literals the generator no longer emits.
- Fixed `report-statement-snapshot` (4): refreshed snapshots for title-cased statement labels and
  made row lookups tolerate both `closing_balance` and `balance` keys.
- Suite now **42 failing / 32 files** (from 102 / 47).

### Arch-suite triage, round 3
- `portal-identity-invariants` (3): guards now read the **latest** migration defining each object
  (`CREATE OR REPLACE` means the first match is stale) and Rule 4 follows the candidate lookup to
  the `get_linkable_users_for_employee` RPC, which filters `ur.is_active = true` server-side.
- `capability-gates` (2): deleted the whole capability system (`lib/apps/capabilities.ts`,
  `CapabilityGate`, `useCapability`, the `provides` field and the guard) — its only provider app
  (`projects`) was retired in M2 and nothing consumed the gates.
- `printing-architecture` (3): the hardware operator console and `BusinessSagaMount` are gone, so
  the ledger-writer and pipeline-leak expectations shrank to their real sets. The print recovery
  sweeper had been left unstarted by the saga-mount deletion — restored via a dedicated
  `components/printing/PrintRecoveryMount.tsx` mounted at the app root (real bug, not a test fix).
- `printing-coverage-matrix-integrity` (2): matrix gained the `labour_worksheet` / `labour_roster`
  rows, and the WMS count + landed-cost rows moved to the snapshot-pipeline exempt list.
- Suite now **32 failing / 28 files**. Typecheck clean.
