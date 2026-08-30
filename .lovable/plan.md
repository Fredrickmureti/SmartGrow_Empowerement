# Smart Grow Empowerment — Microfinance Convergence (living plan)

One microfinance institution. Internal, employee-operated. Converged from the
AccrualFlow platform by controlled migrations — not a rewrite.

Excluded permanently: SaaS/tenants/subscriptions/platform admin, payroll,
attendance, timesheets, time-off, POS, inventory/warehouse, procurement, sales
order-to-cash, client portal.

## Verified current state (checked this turn)

- Backend is the dedicated project `xwxqunklduknceoryrha`; `.env` server and
  `VITE_` keys all point at it. No AccrualFlow database is reachable from here.
- App modules reduced to: contacts, dashboard, finance, hr, me, platform,
  reports, studio. No sales / inventory / POS / warehouse / purchasing page
  trees remain.
- Still present and therefore pending: `src/services/pos`, `src/services/hardware`,
  `src/services/scanner`; HR pages far beyond "system actors".
- No microfinance domain exists yet in code or schema. Existing `%loan%` tables
  are payroll employee-advance leftovers.
- Earlier claims that are recorded but NOT re-verified this turn: typecheck at
  0 errors, arch suite at 32 failing / 28 files. Re-baseline both before acting.

## Working rules (unchanged, enforced)

1. One migration at a time. Scope → dependency graph → code change → build +
   typecheck → affected screens opened → written report appended here → stop.
2. Removal order is always: dependency graph, then code removal, then schema drop.
3. All financial state derived server-side. React never owns balances, interest,
   arrears, allocations or journal amounts.
4. Every domain action is a business event with an accounting hook, never a CRUD
   update. Account mappings stay configurable — no account UUIDs in domain code.
5. Reuse proven platform infrastructure (auth/PIN, shell, RBAC, settings, report
   engine, document engine, GL/COA/journals/fixed assets, audit, storage).
   Adapt rather than duplicate. Build new only for genuine microfinance gaps.

## Phase order

### M0 — Re-baseline (do first, no feature work)
Record actual `tsgo -p tsconfig.app.json` error count, actual vitest arch-suite
pass/fail, and confirm `/`, `/login`, `/dashboard`, `/settings` return 200.
Everything below is gated on this baseline, not on prior claims.

### M3 — Finish de-scoping the SaaS/tenant layer
Dependency analysis showed a single drop is impossible: `platform_admins` is read
by ~30 database functions, and `plan_app_access` / `plan_feature_access` /
`org_entitlement_overrides` back the live entitlement resolver. Sequence, one
small migration each:
1. Rewrite `get_user_session_data` and the entitlement functions to stop reading
   plan tables (single institution ⇒ entitlement resolves from role, not plan).
2. Drop plan / subscription / billing tables.
3. Rewrite the remaining `platform_admins`-dependent functions.
4. Drop platform-admin and tenant-transfer tables.
Also rename the `useSubscriptionCompat` leftover in `SessionContext.tsx`.

### M4 — Remove POS / hardware / scanner and non-actor HR
`services/printing` currently depends on `hardware/*` (types, mediaGeometry,
dispatch) and document printing depends on printing. Order: decouple the printing
seam first, then delete `pos`, `scanner`, `hardware` and their nav/settings/route
remnants. Then reduce HR to system actors only — identity, role, branch, loan
officer assignment, audit — removing compensation, contracts, garnishments,
onboarding, competencies, statutory fields, attendance, timesheets, time-off.
Code removal first; one migration per cohesive group of database objects.

### M5 — Institution identity & settings
Company settings as the single configuration root: name, legal name, address,
contacts, logo, registration/tax, currency, financial settings. Prove the values
flow into report and document data contexts; nothing hardcoded.

### M6 — RBAC, PIN auth, navigation IA
Roles: Super Administrator, Branch Manager, Loan Officer, Credit Officer,
Cashier, Accountant, Collections Officer, Auditor, Reporting User — on the
existing `user_roles` + `has_role` architecture with a separate roles table.
Server-side enforcement authoritative; the shell only hides. Keep PIN login,
rebrand auth/marketing copy, seed the development administrator identity
(fredrickmureti612@gmail.com). No public registration.

### M7 — Finance foundation retained + mapping registry
Keep chart of accounts, hierarchy, journals, GL, fiscal periods, fixed assets,
FX resolver, audit. Add the microfinance account-mapping registry as
configuration: principal receivable, interest income, interest receivable, fee
income, penalty income, cash, bank, mobile money, write-off expense.

### M8 — Clients & groups
Client/member master with KYC, branch, owning loan officer, status, history.
Optional groups with leader and membership; group membership never implies a
group loan. Clients survive loan closure. Officer portfolio scoping applies to
visibility from day one.

### M9 — Loan products (versioned)
Amount limits, term, frequency, interest method, fees, penalties, grace,
eligibility, activation. Immutable product versions so live loans never change
when a product changes.

### M10 — Applications, assessment, approval
Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Requested and approved amounts stay distinct. Assessment and approval are
attributable events with enforced authority. Approval is not disbursement.

### M11 — Loan, schedule engine, disbursement
Loan snapshots contractual terms from the approved application. Server-side
schedule engine per interest method and frequency; the schedule is contractual,
not the payment ledger. Disbursement is a guarded, idempotent business event
posting through the mapping registry.

### M12 — Payments, allocation, arrears, collections
Full / partial / over payments, configurable allocation order (never hardcoded),
reversals and adjustments. Arrears, days past due and PAR derived from schedule
versus actual payments. Collections activity, visits, promises to pay, outcomes,
scoped to officer portfolios.

### M13 — Lifecycle exceptions
Top-up, restructuring, write-off, closure as distinct event-sourced processes.
No destructive updates to loan history.

### M14 — Reporting & documents on the existing engines
Reports: loan portfolio, outstanding principal/interest, active loans, daily /
officer / branch collections, arrears & aging & DPD & PAR, client loan and
payment history, client statement and exposure, applications / approvals /
disbursements / product performance.
Documents: loan agreement, repayment schedule, loan statement, payment receipt,
disbursement confirmation, client statement, collection receipt.
Reuse both engines and their company-information injection; replace only data.

### M15 — Audit, security, hardening
RLS and grant review on every new table, SECURITY DEFINER audit, `auth.users`
exposure, reversal and duplicate-prevention tests, approval and disbursement
controls, accounting traceability, final dead-code removal, arch suite green.

## Per-migration report format
Migration · Objective · Changed · Preserved · Removed · Adapted · Database ·
Dependencies · Verification · Result (PASS/FAIL/BLOCKED) · Next.

## Currently active phase
M0 re-baseline, then M3 step 1. No loan-domain work until M3 and M4 are closed.


===============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT=============
The plan file is updated. It now includes:

- Domain operating model (ASA model) — the five operational pillars you described (individual lending in a group setting with no joint liability, mandatory group meetings as the repayment collection point, face-to-face officer/branch-manager screening, capped first loans with cycle-based graduation, standardized branches) plus what the model explicitly excludes (client portal, self-service applications/payments, algorithmic scoring, group-liability products).
- Legacy data policy — inherited ERP rows are not this institution's data: microfinance surfaces must never read leftover invoices/bills/POS/payroll/CRM data, the payroll `%loan%` tables are flagged as employee-advance artifacts for deletion, and demo data must be authored fresh to match the ASA model.
- Milestones M8, M10, M12 rewritten to encode these rules (group meeting slots, staff-created applications, physical visit assessments, branch-level approval, batch-per-meeting repayment entry).
- Currently active phase updated to reflect M3 closed and M4's real state, so the next agent resumes at the test-manifest pruning instead of wandering.

The same rules are also saved to project memory so any future session applies them automatically. Want me to continue with M4 — pruning the stale architecture test manifests?