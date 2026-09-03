
# Microfinance Convergence — Authoritative Plan (reworked 2026-09-03)

Single-company microfinance platform built on the existing codebase.
Reuse only: auth engine, document engine, navigation/UI shell, and the
reusable Finance engines (COA/GL/journals, banking + reconciliation,
settlement/allocation) — retargeted to microfinance, never sales-oriented.
Everything else ERP is removed, disabled, or left out. No speculative work.

## Verified state (checked directly in the codebase, 2026-09-03)

Backend domain (Postgres, `mf_*`) — EXISTS:
- Tables: clients, groups, group_members, loan_products, loan_product_versions,
  loan_applications, application_assessments, loans, loan_schedule,
  loan_disbursements, loan_events, repayments, repayment_allocations,
  repayment_batches, collection_activities, account_mappings,
  allocation_policy, event_postings.
- Authoritative RPCs: mf_generate_schedule, mf_create_loan_from_application,
  mf_disburse_loan, mf_record_repayment, mf_reverse_repayment,
  mf_write_off_loan, mf_close_loan, mf_reissue_loan, mf_post_event,
  mf_resolve_account (configurable mapping — no hardcoded account IDs).
- Integrity: append-only triggers on loan_events / collection_activities,
  mf_loans_freeze_terms (contractual terms frozen at creation),
  officer/branch RLS scoping via mf_officer_in_scope / mf_loan_in_scope.
- Financial authority is in the DB, not the browser. Confirmed.

Frontend (`src/apps/lending`) — EXISTS: clients, groups, products (+versions),
applications (form/assessment/decision), loans (create/disburse/schedule/
lifecycle), repayments (record), collections (log activity), 5 reports
(portfolio, arrears/PAR, collections, disbursements, client statement),
accounting mappings page, lending document menu wired to the shared document
engine (`src/services/documents/snapshots/lending.ts`).

Auth: invite-only. `/signup` redirects to `/login`; public registration removed.

FIXED this session (previous engineer left it broken, typecheck failing):
`src/lib/permissions.ts` lending wiring is now complete — `LendingPermission`
excluded from the exhaustive role map, `lending` added to PERMISSION_MODULES /
MODULE_LABELS / ACTIVE_PERMISSION_MODULES / MODULE_PERMISSION_MAP /
MODULE_TO_APP_MAP, `LENDING_ROLE_PERMISSIONS` overlaid in
`resolveEffectivePermissions`, and every `src/apps/lending/nav.ts` item now
carries its permission. `bunx tsgo --noEmit -p tsconfig.app.json` passes.

## Remaining milestones (execute one at a time, verify before advancing)

C12 — RBAC hardening (DONE, verified 2026-09-03)
- All 13 lending routes wrapped in `PermissionProtectedRoute`.
- Write actions gated with `can(...)` on every lending page: clients/groups →
  `manageClients`; products → `manageLoanProducts`; applications → `manageApplications`
  (submit/review/assess/mark-ready) and `approveApplications` (approve/reject);
  loans → `manageLoans` (create, top-up, restructure, close, write-off) and
  `disburseLoans`; repayments → `recordRepayments` (batch open/close, capture,
  reverse); collections → `manageCollections` (log activity). Read-only users keep
  view + document access only.
- `bunx tsgo --noEmit -p tsconfig.app.json` passes.
- DB-side: every `mf_*` table carries RLS policies (read/insert/update/delete or
  append-only where required); officer/branch scoping via
  `mf_officer_in_scope` / `mf_loan_in_scope`. Dev admin
  fredrickmureti612@gmail.com exists with role `owner`.


C13 — Accounting integration close-out (NEXT)
- Every business event (disbursement, repayment allocation, reversal,
  write-off, closure) posts through mf_post_event → mf_resolve_account → GL.
- Verify a full lifecycle produces a balanced, traceable journal trail.

C14 — Cash & settlement retarget
- Reuse banking/reconciliation + settlement engine for microfinance cash:
  branch cash/mobile-money receipts, officer collection sheets, batch
  banking of daily collections. Support both group collection batches and
  individual client payments (ASA-style field model).
- Retarget "customer statement" surfaces to client/loan statements.

C15 — ERP removal & hardening
- Remove/disable remaining ERP scaffolding (sales, purchases, POS, inventory,
  products, payroll, HR/recruitment/attendance) after dependency check;
  keep only shared infra the retained apps import.
- Final: typecheck, build, RLS/permission pass, lifecycle test, report and
  document render test.

## Rules
- No payroll, no HR product, no multi-tenancy, no client portal.
- No new engines where a mature one exists — adapt it.
- No frontend-authoritative financial math.





======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================



I've paused C12 partway through. Here's where things stand:

Done this session
- All 13 lending routes in `src/apps/lending/routes.tsx` are now wrapped in `PermissionProtectedRoute` with the correct permission (`viewClients`, `viewLoans`, `viewApplications`, `viewLoanProducts`, `recordRepayments`, `viewCollections`, `viewLendingReports`, `manageLendingConfig`).
- The `usePermissions` hook (`const { can } = usePermissions()`) is wired into all seven lending pages (clients, groups, products, applications, loans, repayments, collections).

Remaining for C12
1. Actually gate the write actions with the `can(...)` checks now available — create buttons plus row actions: clients/groups → `manageClients`; products (new/version) → `manageLoanProducts`; applications (submit/review/assess → `manageApplications`, approve/reject → `approveApplications`); loans (create/lifecycle → `manageLoans`, disburse → `disburseLoans`); repayments (record/reverse → `recordRepayments`); collections (log activity → `manageCollections`).
2. Run `bunx tsgo --noEmit -p tsconfig.app.json` — the hook was inserted by script and hasn't been typechecked yet, so it may need fixups (unused `can`, insertion placement).
3. Verify DB-side officer/branch scoping matches these UI gates for the five lending roles, and confirm the dev admin identity.

Then C13 (accounting close-out), C14 (cash/settlement), C15 (ERP removal) remain per the plan.

==============================NOTE===============================

NOTE
=============
And kindly note: **there is absolutely no room for unnecessary work or credit wastage here.** We need to be highly deliberate about scope.

The objective is to **strip away everything the microfinance system does not need** and immediately create a clean foundation for its business logic. Do not preserve unnecessary ERP complexity simply because it already exists.

What we want to **reuse** from the existing system is specifically:

* **Document generation engine**
* **Authentication/auth engine**
* **Navigation and UI foundation**
* *Banking and reconciliation , payables receivables but now tailored for microfinance**
TO BE PRECISE, WHAT IS REUSABLE, KINDLY REUSE IT INCLUDING PAYMENT SETTLEMENT ENGINE FOR PAYABELES/RECEIVABLES, basically accross the Finance what is reusable use it as long as its microfuiannce tailored because we are building mciro fianance  if its statements instead of customer staments lest it be  talowred towards microfinance not the current sales oriented that was used by the old erp so dont just delete what is reusable and has solid engine that will be painful to rebuild from scratch, reason like a mircofiannce system developer not like a blind bot,  and  if its payment being receuived,  and on the payment reception we need to reason critically here because this sytem is almost operating almost like ASA international kenya which uses the typical old microfinance tradition because this is an upcoming microfiannce startapp  where we have something loan officer overseeign a group but still that does not mean tje system should not allow single customer payment so this means I need you to help me reason here, dont ask me question, just know you are dealign with a microfiannce system  and such not the old erp which dealth with the typical procurement and sales kind of flow no room for an error, be anaytical and critical executioner, 

Everything else should be evaluated critically. If a component, module, workflow, table, dependency, or business rule is not required by the microfinance system, **remove it, disable it, or leave it out of the new scaffold** rather than carrying unnecessary complexity forward.

The client does **not** need another complicated ERP. We are building a focused microfinance platform, so the architecture should be lean, intentional, and optimized around the actual business requirements.

**Do not waste credits exploring or rebuilding things we already know we will not use.** Make the necessary architectural decisions quickly, clear the unnecessary ERP scaffolding, preserve only the reusable foundation, and open the way for us to start implementing the **actual microfinance business logic immediately.**

**Optimize for speed, relevance, and credit efficiency. No unnecessary work.**
