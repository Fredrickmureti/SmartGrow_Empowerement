# Microfinance Convergence — Authoritative Plan (reworked 2026-09-03, 11:5x UTC)

Single-company microfinance platform on the existing codebase.
Reuse only: auth engine, document engine, navigation/UI shell, and the Finance
engines actually needed for lending accounting (COA/GL/journals, banking +
reconciliation). Everything else ERP stays out. No speculative work, no audits
for their own sake.

## Verified state (checked in the codebase)

- Active apps: `dashboard`, `finance`, `lending`, `platform`, `reports`,
  `studio`. Sales, purchases, POS, inventory/products, HR, payroll,
  recruitment, attendance app trees are already gone from `src/apps`.
- Backend domain `mf_*` exists (clients, groups, loan_products +
  versions, applications, assessments, loans, schedule, disbursements,
  events, repayments, allocations, batches, collection_activities,
  account_mappings, allocation_policy, event_postings) with authoritative
  RPCs (`mf_generate_schedule`, `mf_create_loan_from_application`,
  `mf_disburse_loan`, `mf_record_repayment`, `mf_reverse_repayment`,
  `mf_write_off_loan`, `mf_close_loan`, `mf_reissue_loan`, `mf_post_event`,
  `mf_resolve_account`). Financial authority is in the DB, not the browser.
- Integrity: append-only event/collection triggers, frozen contractual terms,
  officer/branch RLS via `mf_officer_in_scope` / `mf_loan_in_scope`.
- Frontend `src/apps/lending`: clients, groups, products (+versions),
  applications (form/assessment/decision), loans (create/disburse/schedule/
  lifecycle), repayments, collections, 5 reports, accounting mappings page,
  documents wired to the shared engine
  (`src/services/documents/snapshots/lending.ts`).
- Auth invite-only; `/signup` → `/login`. Dev admin
  fredrickmureti612@gmail.com exists with role `owner`.
- C12 RBAC hardening: DONE (all 13 lending routes permission-gated, writes
  gated with `can(...)`).
- C13 accounting integration: DONE — every money-moving event posts through
  `mf_post_event` → `mf_resolve_account` → `post_journal_entry_atomic`;
  journals with `source_type = 'mf_loan_event'` balance; postings idempotent;
  all 12 mapping keys configurable in Lending → Configuration → Accounting.
- This session: `ACTIVE_PERMISSION_MODULES` trimmed to microfinance scope
  (contacts, financials, lending, settings, team). ERP/HR modules stay in
  `PERMISSION_MODULES` only so legacy rule rows keep resolving.

## Remaining milestones — one at a time, verify before advancing

C15a — ERP surface strip (DONE 2026-09-03)
- `ACTIVE_PERMISSION_MODULES` trimmed to contacts/financials/lending/settings/team.
- App registry lending entry now uses real lending permission keys
  (`viewClients`, `viewLoanProducts`, `viewApplications`, `viewLoans`,
  `recordRepayments`, `viewCollections`) instead of `viewContacts`.
- `platform_apps` catalogue: `lending` added as a core app; sales, purchases,
  inventory, pos, crm, projects, warehouse, employees, time-off, attendance,
  timesheets, payroll, recruitment, sms marked unavailable + hidden.
- Entitlement model already retired (`useAppAccess` / `useInstalledApps`
  resolve from the local registry — no marketplace, no per-tenant installs).
- Typecheck passes.

C14 — Cash & settlement retarget (NEXT)
- Reuse banking + reconciliation for microfinance cash: branch cash /
  mobile-money receipts, officer collection sheets, batch banking of daily
  collections; both group batches and individual client payments.
- Retarget "customer statement" surfaces to client/loan statements.
- Scope guard: no new engine. Adapt existing banking screens/services only
  where the lending flow needs them.

C15b — Final dead-code strip & hardening
- Delete leftover ERP-only pages/services/features not imported by
  dashboard / finance / lending / platform / reports / studio (check
  `src/pages`, `src/features`, `src/services` by import graph first).
- Prune `src/parked-modules.d.ts` stubs that no retained file needs.
- Close-out: typecheck, build, RLS/permission pass, one full loan lifecycle
  test, report + document render test.

## Rules
- No payroll, no HR product, no multi-tenancy, no client portal, no ERP
  workflow revival.
- No second implementation where a mature engine exists — adapt it.
- No frontend-authoritative financial math.
- Do not investigate or polish anything outside microfinance scope.


======================THIS WAS THE LAST MESSAG FROM THE AGENT BEFORE IT RUN OUT OF TIME=================



C15a done: lending now uses its real permission keys everywhere, the Access Groups module list is microfinance-only, and the app catalogue has Lending as a core app with all ERP/HR apps switched off. Next is C14 (cash & settlement retarget) — say go and I'll execute it.


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
