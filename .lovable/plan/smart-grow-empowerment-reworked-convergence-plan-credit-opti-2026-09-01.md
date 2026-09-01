# Smart Grow Empowerment — reworked convergence plan (credit-optimised)

Single source of truth. Replaces the previous plan's milestone order. Nothing
below re-opens a closed milestone.

## Verified state (checked in the codebase today, not taken on trust)

| Claim | Verdict |
| --- | --- |
| M0 test re-baseline, M3b SaaS/platform-admin de-scope | Holds. `SubscriptionAccessContext`, entitlement hooks gone. |
| M4 printing/hardware decoupling + DB retirement | Holds. `src/services/hardware`, `src/hooks/hardware`, `services/pos`, `services/scanner` are all absent. |
| M5 payroll/attendance/HR retirement | NOT started. 118 source files still reference payroll, 31 reference attendance; the database still has 50 `payroll_*` and 7 `attendance_*` tables. |
| Database is "hollow" | False. 807 public tables: 181 retail/WMS, 50 payroll, 40 ERP document tables. No microfinance tables exist. |
| Any lending domain exists | No. The 13 `%loan%` tables are payroll employee-advance artifacts, not lending. |

Genuine resume point: **after M4**. The previous plan then queued five
demolition milestones (M5–M7) before any lending work.

## The change of strategy

Demolishing ~600 dormant ERP tables one dependency-graphed migration at a time
is the single most expensive thing we could do, and it produces zero
microfinance capability. Unused tables cost nothing at runtime; unused code
costs nothing once it is unreachable.

So the order flips:

```text
OLD: remove everything  → then build lending   (months of removal first)
NEW: hide/unwire ERP    → build lending now    → sweep dead schema at the end
```

Removal is downgraded from "milestone" to "cheap cleanup", and only where it
blocks something. Lending starts immediately after one unwiring pass.

## Milestones

### C1 — Unwire, don't demolish (one pass, code only)
Cut every non-microfinance surface out of the running application by removing
its routes, nav entries and app-registry entries — not by deleting hundreds of
files or dropping tables.

- App registry / nav keeps only: Dashboard, Clients (Contacts), Lending
  (new, empty), Finance, Reports, Settings, Team.
- Delete the marketing/SaaS pages that are now dead ends: `AcceptOwnership`,
  Careers, Blog, Features, Demo, Downloads/Install, Pricing-adjacent pages.
- HR collapses to the actor surfaces only: employee identity, role, branch and
  officer assignment, org/positions/locations. Payroll, attendance, benefits,
  onboarding, competency and exit screens are unrouted in this pass.
- No schema changes. No dependency-graph exercise for code nobody can reach.

Verification: typecheck clean, build OK, every remaining nav item opens.

### C2 — Institution identity + RBAC + accounting mappings
The one configuration milestone lending depends on.

- Single institution: company settings become the config root that reports and
  documents read (no hardcoding), branches stay as operational scope.
- Roles collapsed to the microfinance set (Super Admin, Branch Manager, Loan
  Officer, Credit Officer, Cashier, Accountant, Collections Officer, Auditor,
  Reporting) on the existing `user_roles` + `has_role` model. PIN auth kept.
- New `microfinance_account_mappings` config table: principal receivable,
  interest income, interest receivable, fee income, penalty income, cash, bank,
  mobile money, write-off expense. Domain code never names an account UUID.

### C3 — Clients & groups (ASA model)
Client master with KYC, branch, owning loan officer, status, cycle history.
Groups with leader, membership and a fixed weekly meeting slot (day/time/place)
— the meeting is the collection point. Individual liability only; membership
never implies a joint loan. Clients survive loan closure.

### C4 — Loan products (immutable versions)
Amount band, term, frequency, interest method, fees, penalties, grace,
eligibility, activation. Versions are frozen so live loans never mutate when a
product is edited.

### C5 — Applications → assessment → approval
Draft → Submitted → Under review → Approved/Rejected → Ready for disbursement.
Staff-created for identified clients. Assessment is a recorded physical business
visit (officer + branch manager). Approval is attributable and bounded by
authority limits and cycle eligibility. Requested ≠ approved amount.
Approval ≠ disbursement.

### C6 — Loan, schedule engine, disbursement
Loan snapshots contractual terms from the approved application. Server-side
schedule engine per interest method and frequency (the schedule is contractual,
not a ledger). Disbursement is an idempotent, guarded business event that posts
through the C2 mapping registry into the existing journal/GL.

### C7 — Repayments, allocation, arrears, collections
Batch-per-meeting repayment entry with per-member receipts, plus partial, over
and reversal handling. Allocation order is configuration, never hardcoded.
Arrears, DPD and PAR derived server-side from schedule vs actual payments.
Collections activity, visits, promises to pay — scoped to officer portfolios.

### C8 — Lifecycle exceptions
Top-up, restructuring, write-off, closure as event-sourced processes with
approval and accounting treatment. No destructive updates to loan history.

### C9 — Reports & documents on the existing engines
Portfolio, outstanding principal/interest, daily/officer/branch collections,
arrears aging and PAR, client statement and exposure, applications/approvals/
disbursements. Documents: loan agreement, repayment schedule, loan statement,
payment receipt, disbursement confirmation, collection receipt. Both reuse the
existing engines with institution data injected — no new renderer.

### C10 — Hardening + one bulk schema sweep
RLS/grants audit on every new table, reversal/duplicate/approval controls,
security posture. Then, and only then, one bulk drop of the confirmed-dead ERP
schema (retail/WMS, payroll, attendance, procurement, POS) in a small number of
grouped migrations — after nothing reads it.

## Working rules (unchanged where they earn their keep)

1. All financial state derived server-side. React never owns balances, interest,
   arrears, allocations or journal amounts.
2. Every domain action is a business event with an accounting hook, not a CRUD
   update. Account mappings stay configuration.
3. Every new public table ships GRANTs + RLS + policies in the same migration;
   migrations stay small and single-purpose.
4. Inherited ERP rows are not this institution's data — no microfinance surface
   ever reads legacy invoices, bills, POS, payroll, CRM or inventory rows.
5. Permanently out of scope: SaaS/tenants/subscriptions/platform admin, payroll,
   attendance, timesheets, POS, inventory, warehouse, procurement, sales
   order-to-cash, client portal, public registration, hardware estate.
6. Verification per milestone is typecheck + build + open the affected screens.
   Full-suite green is a C10 goal, not a per-milestone gate — the inherited
   failing files are ERP tests that C10 deletes.

## Technical notes

- Legacy tables are left in place through C1–C9 deliberately: they are unread,
  carry no runtime cost, and dropping them early risks breaking retained
  platform functions (journals, documents, audit) that still reference them.
- New lending tables are namespaced (`mf_` or explicit domain names) so they
  never collide with the inherited `%loan%` payroll artifacts.
- The catch-all `src/routes/$.tsx` keeps bridging deep URLs into the legacy SPA;
  no router migration is in scope.

## Next action

Start C1.
