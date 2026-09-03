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

C12 — RBAC hardening (NEXT)
- Gate lending routes/actions on the new permissions (not just nav).
- Confirm DB-side scoping matches UI gates for loan_officer,
  collections_officer, credit_officer, branch_manager, auditor.
- Seed/verify the dev admin identity fredrickmureti612@gmail.com.

C13 — Accounting integration close-out
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
