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
