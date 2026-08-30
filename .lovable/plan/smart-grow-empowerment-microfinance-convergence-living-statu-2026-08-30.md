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

## Domain operating model — the institution we are building for

Smart Grow Empowerment is a **small, traditional, branch-based microfinance
institution operating on the ASA model** (as ASA International Kenya runs it).
It is NOT an online lending platform. Read this before touching any milestone
from M8 onward — it defines what the domain must and must not do.

The ASA model, as it actually operates:

1. **Target group & group-based access.** Clients are low-income micro-entrepreneurs
   (predominantly women running small businesses). Lending is INDIVIDUAL — each
   member is responsible for her own loan; there is NO joint-liability group
   lending. But membership of a local client group is required to access loans.
   Groups exist for discipline, peer knowledge and meeting logistics, not as
   co-borrowers. (Consequence for M8: group membership ≠ group loan, and the
   loan always has exactly one client as the obligor.)
2. **Mandatory group meetings.** Each group meets at a fixed time, day and place.
   The loan officer attends in person. Repayments are collected AT THE MEETING,
   recorded publicly, and receipts issued. Clients do not log in anywhere; the
   officer is the system's hands. (Consequence for M12: repayment entry is a
   staff-side batch-per-meeting workflow keyed by group/meeting/attendance, not
   a client self-service payment page.)
3. **Face-to-face screening before any money moves.** The loan officer and branch
   manager physically visit the applicant's business, verify it exists, assess
   cash flow and obligations, and record the assessment. There is no anonymous
   signup → form → money flow. (Consequence for M10: an application is created
   BY STAFF on behalf of an identified, KYC'd client; assessment is a physical
   visit with a recorded verdict; approval happens at the BRANCH, by named
   officers, within authority limits.)
4. **Capped first loans, cycle-based graduation.** First-cycle loans are small
   by policy. Limits rise only after a completed, well-repaid cycle. The client's
   repayment history across cycles is the credit score. (Consequence for M9/M10:
   products carry per-cycle ceiling rules; eligibility for cycle N+1 amounts is
   derived from the client's completed-cycle record, never free-typed.)
5. **Standardized, low-cost branches.** Every branch runs the same simple,
   standardized procedures and documents. (Consequence: configuration is
   institution-level; branches differ in staff and portfolio, not in rules.)

What this model EXCLUDES (do not build, do not leave seams for):
- No client portal, no client login, no online self-application, no self-service
  repayment. All client-facing actions are performed by staff.
- No credit-scoring automation or algorithmic approval. Humans decide, the
  system records and enforces authority limits.
- No joint-liability/group-loan product.
- No mobile-money self-payment integration as the primary flow; repayments are
  officer-collected (cash or mobile money recorded by the officer).

## Legacy data policy — do NOT carry the ERP's data forward

When the microfinance domain work begins, the inherited AccrualFlow database
contents are NOT this institution's data. Rules for every agent:

- Do not build microfinance screens over leftover ERP rows (invoices, bills,
  POS transactions, payroll runs, CRM leads, inventory). The new domain reads
  only microfinance tables plus the retained finance foundation (chart of
  accounts, journals, periods) and the provisioned single organization/business/
  branch/actor set.
- The 14 `%loan%` tables are payroll employee-advance artifacts, NOT lending
  tables. Do not reuse or extend them for client loans; they are scheduled for
  removal with the HR de-scope (M4).
- Demo/seed data for the microfinance domain must be authored fresh to match
  the ASA model above (groups, meetings, officer-collected repayments, cycle
  graduation) — never recycled ERP fixtures.
- Before M14 reporting goes live, verify no report or document template pulls
  from dropped or out-of-scope ERP tables.

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
Groups with leader, membership, and a fixed weekly meeting slot (day, time,
place) — the meeting is the collection point. Individual lending only: group
membership never implies a group loan and never creates joint liability.
Clients survive loan closure and accumulate cycle history.

### M9 — Loan products (versioned)
Amounts, term, frequency, interest method, fees, penalties, grace, eligibility,
activation. Product versions immutable so live loans never change.

### M10 — Applications, assessment, approval
Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Applications are created BY STAFF for identified clients — never self-submitted.
Assessment is a recorded physical business visit (officer + branch manager
verdict). Approval is a branch-level, attributable decision within authority
limits. Requested and approved amounts stay distinct; approved amount is
capped by the client's cycle eligibility. Approval ≠ disbursement.

### M11 — Loan, schedule engine, disbursement
Loan snapshots contractual terms from the approved application. Server-side
schedule engine per interest method/frequency. Disbursement is a guarded,
idempotent business event posting through the mapping registry.

### M12 — Payments, allocation, arrears, collections
Staff-recorded repayments collected at group meetings (batch entry per meeting,
with per-member receipts), plus full/partial/over payments, configurable
allocation order (never hardcoded), reversals and adjustments. Arrears, DPD and
PAR derived from schedule vs actual payments. Collections activity, visits,
promises to pay, outcomes — scoped to officer portfolios. No client self-service
payment surface.

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
M3 is CLOSED (entitlement logic rewritten plan-free; plan/trial/billing
functions and tables dropped; typecheck clean, build OK).
M4 in progress: `services/pos`, `services/scanner`, scanner drivers and their
arch tests are removed; typecheck is clean. Remaining in M4: prune the
file-manifest architecture tests that still reference deleted retail surfaces
(suite currently at 46 failing files vs the 32-file baseline), decouple
`services/printing` from `services/hardware` (PDF/document printing stays),
then reduce HR to system actors and drop the payroll/attendance schema
(including the payroll `%loan%` tables) one migration per cohesive group.
No loan-domain work until M4 is closed. When domain work starts, obey the
"Domain operating model" and "Legacy data policy" sections above.
