# Smart Grow Empowerment — convergence plan (verified 2026-09-01)

Single source of truth. Strategy unchanged: unwire the ERP, build lending now,
sweep dead schema once at the end. Reuse only three things from AccrualFlow —
document engine, auth engine (PIN), navigation/UI foundation.

Backend note: this project is already connected to the external Supabase
project used by the app (`xwxqunklduknceoryrha`). No new connection is needed;
"Smart Grow Empowerment" is the app, not a second database.

## Verified state (checked in the codebase today)

| Claim | Verdict |
| --- | --- |
| M0 re-baseline, M3b SaaS/platform-admin de-scope, M4 hardware/printing retirement | Hold |
| M5 payroll/attendance/HR retirement | Not started (still ~118 payroll refs, 50 `payroll_*` tables) |
| C1 marketing/SaaS page deletion | Done — `src/components/landing`, `src/pages/resources`, `src/pages/legal` absent; `Index.tsx` is now a redirect-only entry |
| C1 build health | Build OK, no outstanding build errors |
| C1 registry prune | Not done — `REPORTS_APP` still registers Sales + 7 stock/inventory report modules |
| `LENDING_APP` + `/lending/*` scaffold | Does not exist |
| Any microfinance/lending schema | None. The 13 `%loan%` tables are payroll advance artifacts |

Genuine resume point: **mid-C1**, at the registry prune.

## C1 — Unwire, don't demolish — DONE (2026-09-01)

- `REPORTS_APP` pruned of Sales + the seven stock/inventory report modules.
- `LENDING_APP` registered (basePath `/lending`) with the placeholder shell in
  `src/apps/lending/` and `/lending/*` mounted in `src/App.tsx`.
- `EMPLOYEES_APP` already actor-only (no payroll/attendance/benefits modules).
- Finance `reports/sales` + `reports/purchases` routes, their lazy imports and
  page files removed; `sales-reports` / `purchase-reports` dropped from
  `ReportRegistry` (definitions + relation pairs); Sales/Stock links dropped
  from the sidebar; the dead `AppSidebar` reference in the eliminations test
  and the stale Sales/Stock entries in the reporting tests removed.
- Verified: `tsgo` typecheck clean; the four touched architecture test files
  pass. Remaining suite failures are inherited ERP tests, retired in C10.

## C2 — Institution identity + RBAC + accounting mappings

- Company settings become the single institution config root that reports and
  documents read; branches remain operational scope.
- Roles collapsed to the microfinance set (Super Admin, Branch Manager, Loan
  Officer, Credit Officer, Cashier, Accountant, Collections Officer, Auditor,
  Reporting) on the existing `user_roles` + `has_role` model. PIN auth kept.
- New `mf_account_mappings` config table: principal receivable, interest income,
  interest receivable, fee income, penalty income, cash, bank, mobile money,
  write-off expense. Domain code never names an account UUID.
- Seed `fredrickmureti612@gmail.com` as the development Super Admin.

## C3 — Clients & groups

Client master with KYC, branch, owning loan officer, status, cycle history.
Groups with leader, membership and a fixed weekly meeting slot. Individual
liability only; membership never implies a joint loan. Clients survive closure.

## C4 — Loan products (immutable versions)

Amount band, term, frequency, interest method, fees, penalties, grace,
eligibility, activation. Product versions frozen so live loans never mutate.

## C5 — Applications → assessment → approval

Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Assessment recorded as an attributable physical visit; approval bounded by
authority limits and cycle eligibility. Requested ≠ approved. Approval ≠
disbursement.

## C6 — Loan, schedule engine, disbursement

Loan snapshots contractual terms. Server-side schedule engine per interest
method and frequency (contractual, not a ledger). Disbursement is an idempotent
guarded event posting through the C2 mappings into the existing journal/GL.

## C7 — Repayments, allocation, arrears, collections

Batch-per-meeting entry with per-member receipts; partial, over and reversal
handling. Allocation order is configuration. Arrears, DPD and PAR derived
server-side. Collections activity, visits, promises — scoped to officer
portfolios.

## C8 — Lifecycle exceptions

Top-up, restructuring, write-off, closure as event-sourced processes with
approval and accounting treatment. No destructive updates to loan history.

## C9 — Reports & documents on the existing engines

Portfolio, outstanding principal/interest, daily/officer/branch collections,
arrears aging and PAR, client statement and exposure, applications/approvals/
disbursements. Documents: loan agreement, repayment schedule, loan statement,
payment receipt, disbursement confirmation, collection receipt. Existing
renderers reused with institution data injected.

## C10 — Hardening + one bulk schema sweep

RLS/grants audit on every new table, reversal/duplicate/approval controls,
security scan. Then one grouped bulk drop of confirmed-dead ERP schema
(retail/WMS, payroll, attendance, procurement, POS) plus deletion of their
dead code and tests — after nothing reads them.

## Working rules

1. All financial state derived server-side; React never owns balances,
   interest, arrears, allocations or journal amounts.
2. Every domain action is a business event with an accounting hook, not a CRUD
   update. Account mappings stay configuration.
3. Every new public table ships GRANTs + RLS + policies in the same migration;
   migrations stay small and single-purpose.
4. Inherited ERP rows are not this institution's data — no microfinance surface
   reads legacy invoices, bills, POS, payroll, CRM or inventory rows.
5. Permanently out of scope: SaaS/tenants/subscriptions/platform admin, payroll,
   attendance, timesheets, POS, inventory, warehouse, procurement, sales
   order-to-cash, client portal, public registration, hardware estate.
6. Per-milestone verification is typecheck + build + open the affected screens.
   Full-suite green is a C10 goal; inherited failing ERP tests die in C10.
7. No exploratory audits of code or tables we already know are out of scope.

## Next action

Start C2 — institution identity (company settings as the single config root),
the microfinance role set on the existing `user_roles`/`has_role` model, and
the `mf_account_mappings` config table. This is the first milestone that
touches the database.



=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======

Stopped here — no further tool calls.

Done this turn (C2, partially):

Added the microfinance roles to the app_role enum: branch_manager, loan_officer, credit_officer, collections_officer, auditor (existing super_admin, admin, accountant, cashier reused).
Created public.mf_account_mappings — business + optional branch scope, mapping_key (principal receivable, interest receivable/income, fee income, penalty income, cash, bank, mobile money, write-off expense, loan loss provision, suspended interest), account_id → accounts, unique per business/branch/key, GRANTs, RLS (read = business access; write = super admin/admin/accountant), updated_at trigger. No new linter findings (3652 before and after — all inherited).
Granted fredrickmureti612@gmail.com the super_admin role in its organization.
Added src/hooks/useMfAccountMappings.ts — typed mapping specs, branch-override resolution, and a save mutation.
Remaining for C2:

A "Accounting mappings" settings surface under /lending/settings/accounting (page + route + nav entry) using AccountCombobox and the new hook — the hook is written but nothing renders it yet.
Verify typecheck/build after that page lands (src/hooks/useMfAccountMappings.ts is currently unused, which is safe but unverified).
Update .lovable/plan.md: mark C2 schema/roles done, leave the settings surface as the open item, then C3 (clients & groups).





NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
