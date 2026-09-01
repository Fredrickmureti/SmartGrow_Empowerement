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

## C1 (finish) — Unwire, don't demolish

Code only, no schema changes.

1. Prune `REPORTS_APP.modules`: drop `sales`, `stock`, `inventory-valuation`,
   `stock-ledger`, `stock-aging`, `lot-traceability`, `stock-adjustments`,
   `stock-transfers`.
2. Collapse `EMPLOYEES_APP` to actor surfaces only (employees, departments,
   job positions, work locations, org chart, configuration) — no payroll,
   attendance, benefits, onboarding, competency, exit entries.
3. Add `LENDING_APP` (basePath `/lending`, modules: Clients, Groups, Products,
   Applications, Loans, Repayments, Collections) with an empty placeholder
   route scaffold so the shell renders and later milestones fill it in.
4. Keep the visible app set to: Home/Dashboard, Lending, Contacts (Clients),
   Finance, Reports, Studio (later review), Settings, My Workspace.
5. Verify: typecheck + build clean, every remaining nav item opens.

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

Finish C1 (registry prune, HR collapse, `LENDING_APP` scaffold, nav check),
then start C2.



=============THIS WAS THE LAST MESSAGE IT GAVE BEFORE ITS TIME RUN OUT======

Work paused mid-C1. Here's the state:

Done this session
- Verified the previous engineer's claims: marketing/SaaS surface deletions hold and the build is clean; the registry prune, HR collapse and lending scaffold were not done.
- Pruned `REPORTS_APP` of the Sales and the seven stock/inventory report modules.
- Added `LENDING_APP` to the registry (Core group, sortOrder 2) plus a full lending shell: `src/apps/lending/` with `nav.ts`, `LendingLayout.tsx`, `PlaceholderSurface.tsx`, `routes.tsx`, `index.ts` — surfaces for Clients, Groups, Products, Applications, Loans, Repayments, Collections, each labelled with the milestone that fills it.
- Mounted `/lending/*` in `src/App.tsx` and exported the app from `src/apps/index.ts`. Typecheck and build were clean at that point.

In-flight, needs finishing next session
- I began unwiring the Finance sales/purchase report routes. The `SalesReports`/`PurchaseReports` lazy imports in `src/apps/finance/routes.tsx` were replaced with a comment, the `reports/sales` route block was removed, and the Sales/Stock entries were dropped from `src/components/layout/AppSidebar.tsx` — but the `reports/purchases` block removal failed on a whitespace mismatch, so `src/apps/finance/routes.tsx` currently still renders `<PurchaseReports />` with no import, and `src/pages/reports/SalesReports.tsx` / `PurchaseReports.tsx` were deleted. This will not typecheck or build until the `reports/purchases` route block is removed — that is the single first fix next session.
- Then: confirm every remaining nav item opens, and C1 is closed. C2 (institution identity, microfinance roles, `mf_account_mappings`) is next and is the first milestone touching the database.






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
