# Smart Grow Empowerment — Microfinance Convergence (reworked plan)

Single-company microfinance system, converged from the AccrualFlow platform.
Not SaaS, no tenants, no payroll, no POS, no client portal.

## Phase 0 — Verification of the previous engineer's work (done this turn)

Checked directly against the codebase and the connected database
(`xwxqunklduknceoryrha`, the only SQL target).

Confirmed true:
- Stack builds. Latest build entry is `build OK`; `tsgo --noEmit` reports 0 errors.
- Database is populated, not hollow: 843 tables, 3,083 functions, 2,082 policies.
- Tenant is provisioned: 1 organization, 1 business, 1 branch, 1 auth user,
  101 chart-of-accounts rows.
- ERP page/component trees for sales, purchasing documents, inventory, POS,
  warehouse and scanner UI are gone from `src/pages` and `src/components`.

Corrected / newly found (treated as pending work, not done):
- **No microfinance domain exists at all** — zero client, group, loan product,
  application, loan, schedule, disbursement, repayment or collections tables,
  and zero domain code. The 14 `%loan%` tables in the database are payroll
  employee-loan and advance-recovery tables, i.e. out-of-scope leftovers, not
  the lending domain. Everything from Migration 08 onward is untouched.
- **SaaS surface is still live**: ~30 platform-admin pages (organizations,
  subscriptions, plan builder, invoices, payments, demo requests, app catalog),
  plus `useSubscription*` hooks, `Upgrade`, `BillingHistory`, `Apps`,
  `SelectOrganization`, tenant ownership transfer. The client explicitly
  rejected this.
- **Out-of-scope services survive** under `src/services/pos`, `.../hardware`,
  `.../scanner`, and payroll/attendance/time-off schema remains in the database.
- **HR is far wider than "system actors"**: compensation history, contracts,
  garnishments, exit clearance, onboarding templates, competencies, statutory
  fields.
- Auth/marketing surfaces are still AccrualFlow-branded.
- Security posture inherited wholesale: ~3.8k linter findings, tables without
  RLS, SECURITY DEFINER views, a view exposing `auth.users`.

So the genuinely completed milestones are: stack repair, environment isolation,
dangling-import purge, tenant bootstrap. Work resumes at dependency-scoped
de-scoping (M3), not at the lending domain.

## Milestones

Each milestone ends with: build + typecheck green, affected screens opened,
a written migration report appended here, then stop.

### M3 — De-scope the SaaS/tenant layer
Dependency graph first, then remove platform-admin, subscription, plan/billing,
demo-request and organization-switching surfaces. Collapse "current
organization/business" resolution to the single provisioned institution so the
shell, RBAC and scoping keep working without a tenant chooser.

### M4 — De-scope remaining ERP/HR excess
Remove POS/hardware/scanner services, and HR surfaces beyond system actors
(compensation, contracts, garnishments, payroll, attendance, time-off,
timesheets). Employees keep: identity, role, branch, officer assignment, audit.
Database objects are dropped only after code references are gone, one migration
per cohesive group.

### M5 — Institution identity & settings
Company settings as the single configuration root (name, legal, address,
contacts, logo, registration/tax, currency, financial settings), verified to
flow into the report and document data contexts rather than being hardcoded.

### M6 — RBAC, PIN auth, navigation IA
Microfinance roles (Super Admin, Branch Manager, Loan Officer, Credit Officer,
Cashier, Accountant, Collections Officer, Auditor, Reporting User) on the
existing `user_roles` + `has_role` architecture. Server-side enforcement is
authoritative; the shell only hides. Rebrand login/marketing; keep PIN login.
Seed the development administrator identity.

### M7 — Finance foundation retained
Keep chart of accounts, hierarchy, journals, GL, periods, fixed assets, FX
resolver, audit. Add the microfinance account-mapping registry (principal
receivable, interest income/receivable, fee income, penalty income, cash/bank/
mobile money, write-off) as configuration — no account UUIDs in domain code.

### M8 — Clients & groups
Client/member master with KYC, branch, owning loan officer, status, history.
Optional groups with leader and membership. Group membership does not imply a
group loan. Clients survive loan closure.

### M9 — Loan products (versioned)
Amounts, term, frequency, interest method, fees, penalties, grace, eligibility,
activation. Product versions are immutable so live loans never change when a
product is edited.

### M10 — Applications, assessment, approval
Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Requested and approved amounts stay distinct. Assessment and approval are
attributable events with enforced authority; approval ≠ disbursement.

### M11 — Loan, schedule engine, disbursement
Loan snapshots contractual terms from the approved application. Server-side
schedule engine per interest method/frequency. Disbursement is a guarded,
idempotent business event that posts through the mapping registry.

### M12 — Payments, allocation, arrears, collections
Full/partial/over payments, configurable allocation order (never hardcoded),
reversals and adjustments. Arrears, DPD and PAR derived from schedule vs actual
payments. Collections activity, visits, promises to pay, outcomes — scoped to
officer portfolios.

### M13 — Lifecycle exceptions
Top-up, restructuring, write-off, closure as distinct event-sourced processes.
No destructive updates to loan history.

### M14 — Reporting & documents on the existing engines
Portfolio, collections, arrears/PAR, client and lending reports registered in
the existing report engine. Loan agreement, repayment schedule, loan statement,
payment receipt, disbursement confirmation, client statement, collection
receipt through the existing document engine.

### M15 — Audit, security and hardening
Dedicated pass on the inherited security posture (RLS gaps, SECURITY DEFINER
views, `auth.users` exposure), plus reversal, duplicate-prevention, approval and
traceability testing, and final dead-code removal.

## Technical notes

- One migration at a time; no bulk replay of the 2,882-file inherited history.
- All financial state is derived server-side; React never owns balances,
  interest, arrears, allocations or journal amounts.
- Every domain action is modelled as a business event with an accounting hook,
  not a CRUD update.
- Removal order is always: dependency graph → code removal → build/typecheck →
  schema drop.

## Standing constraints

- Excluded: POS, payroll, attendance, timesheets, time-off, client portal,
  SaaS/tenant/subscription/platform-admin.
- Purchases: keep only bills/expenses if the institution needs operating-cost
  accounting; drop procurement, RFQ, supplier lifecycle and receiving.
- Backend-authoritative, business-event driven, configurable account mappings.
