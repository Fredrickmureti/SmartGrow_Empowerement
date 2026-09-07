# Authorization convergence — status and next waves (2026-09-07)

## Completed and verified (do NOT repeat)

- Access-group seeding, governance registry parity, module registry pruning,
  settings/document/email vocabulary rewrite in `src/` — done and verified.
- Wave S-4 vocabulary fixes: `src/types/documentTemplate.ts`,
  `src/hooks/useDocumentTemplates.ts`,
  `src/components/templates/DocumentTemplateBuilder.tsx`. `bunx tsgo --noEmit`
  clean, build OK.
- Wave G-5 checks: settings vocabulary (0 hits under `src/components/settings`,
  `src/pages/settings`), branch isolation on `mf_loans` /
  `mf_loan_applications` / `mf_repayments` (branch-qualified SELECT/UPDATE,
  `mf_can(...)` on INSERT), Loan Officer cannot approve/disburse, Branch
  Manager scope — all PASS from source + database evidence. No signed-in
  browser walk is possible here (`external_unmanaged` auth).
- `permission_group_rules.module` values are already microfinance-only:
  accounting, applications, audit, branches, clients, collections,
  loan_products, loans, repayments, reports, settings, team, treasury.

## New findings from this session's investigation

Evidence gathered by querying `governance_action_registry`,
`governance_modules`, `branch_overridable_settings`, `platform_apps`,
`pg_trigger`, `pg_proc`, and `information_schema.columns`, plus source greps.

1. **Self-action guards missing on lending tables (confirmed, unchanged).**
   `sod_*` triggers exist only on `approval_history`, `approval_rules`,
   `bank_accounts`, `expenses`, `journal_entries`, `payments`. None on
   `mf_loan_applications`, `mf_loans`, `mf_repayments`, although the registry
   declares `loan.approve`, `loan.disburse`, `loan.restructure`,
   `loan.write_off`, `repayment.reverse`, `reversal.loan_repayment`.
2. **`platform_apps` still lists the whole ERP catalogue** — Sales, Purchases,
   Inventory, Warehouse, Point of Sale, Payroll, Recruitment, Time Off,
   Timesheets, Attendances, Employees, Projects, CRM, Studio, Twilio SMS.
   This table feeds app entitlement/marketplace surfaces, so ERP apps can
   still appear as installable/visible. Microfinance-relevant rows: Finance,
   Lending, Contacts, Reports, Settings.
3. **Resource Center app dropdown is hardcoded ERP** —
   `src/features/resources/appOptions.ts` lists Sales, Purchases, Inventory,
   Point of Sale, Payroll, CRM (used by `ResourceCenterLauncher.tsx`).
4. **Legacy settings columns still exist and are still read.**
   `businesses.invoice_prefix / estimate_prefix / bill_prefix /
   sales_return_prefix / require_bill_approval /
   allow_duplicate_vendor_invoice_numbers / block_bill_approval_on_match_exception /
   payroll_overtime_multiplier / payroll_standard_hours_per_day /
   payroll_standard_working_days / payroll_self_approval_policy`;
   `branches.invoice_prefix_suffix / default_warehouse_id`.
   `src/contexts/BusinessContext.tsx` (L26-28, L51-53) and
   `src/contexts/BranchContext.tsx` (L29-30, L203, L230-231) still mirror them
   into app state.
5. **Governance module teardown functions for retired ERP domains remain:**
   `reset_module__hr`, `reset_module__pos`, `reset_module__sales`,
   `reset_module__costing`, `reset_module__events`. `governance_modules` rows
   themselves are already clean (ancillaries, banking, finance, fixed_assets,
   lending, sequences, transactions_ledger).
6. **`branch_overridable_settings` is clean** (contact/branding/receipt keys
   only). The Spend/expense entries in the governance registry are legitimate —
   expenses remain a live microfinance module.

## Wave G-6 — Enforce self-action guards on lending (highest priority)

Objective: make the declared lending SoD rules real at the database layer.

Changes (one small migration per object, per the project rule):
- `sod_mf_loan_applications_guard` BEFORE UPDATE on `mf_loan_applications`,
  calling `governance_assert_not_self` with `loan.approve`.
- `sod_mf_loans_guard` BEFORE UPDATE on `mf_loans` for `loan.disburse`,
  `loan.restructure`, `loan.write_off`, keyed off the state transition.
- `sod_mf_repayments_guard` BEFORE UPDATE on `mf_repayments` for
  `repayment.reverse` / `reversal.loan_repayment`.
Mirror `guard_journal_entry_self_approval` exactly (same SQLSTATE 42501 +
`GOV_SELF_ACTION` hint, so `parseGovernanceError` already handles the UI).

Tests: extend `src/test/architecture/sod-coverage.test.ts` to require a
`sod_*` trigger for every `mf_*` `subject_table` in
`governance_action_registry`; then re-run the refusal test.

Acceptance: the officer who created/submitted a loan cannot approve, disburse,
restructure, write off or reverse it; a second actor can. Risk: over-broad
guards blocking legitimate system/service-role postings — scope each guard to
the specific column transition and exempt service_role. Rollback: drop trigger.

## Wave G-7 — App catalogue convergence

Objective: no retired ERP app can be seen, installed or entitled.

- Audit consumers of `platform_apps` (marketplace tiles, `useAppAccess`,
  `plan_app_access`, `organization_installed_apps`) before touching rows.
- Deactivate rather than delete: set `is_available=false`,
  `is_visible_in_signup=false` for the 15 ERP rows; keep the rows so historical
  `organization_installed_apps` / audit FKs stay intact.
- Rewrite `src/features/resources/appOptions.ts` to the microfinance set
  (getting-started, dashboard, clients, lending, collections, finance, reports,
  platform).
- Verify no installed-app row for this org still points at a deactivated app;
  if one does, mark `is_active=false` (never delete history).

Acceptance: app launcher, marketplace and Resource Center show only
microfinance apps; direct routes to retired apps still 404/redirect.

## Wave G-8 — Legacy settings column retirement

Ordered, dependency-aware, non-destructive first:
1. Stop reading: remove the legacy fields from `BusinessContext` and
   `BranchContext` (types, select lists, mirrors) and from
   `src/test/architecture/no-org-identity-reads.test.ts`'s FORBIDDEN regex.
2. Confirm zero remaining references (`rg` for each column name).
3. Only then a migration dropping `businesses.invoice_prefix`,
   `estimate_prefix`, `bill_prefix`, `sales_return_prefix`,
   `require_bill_approval`, `allow_duplicate_vendor_invoice_numbers`,
   `block_bill_approval_on_match_exception`, the four `payroll_*` columns, and
   `branches.invoice_prefix_suffix`, `default_warehouse_id` — one small
   migration per table, after checking no view/function/policy depends on them
   (`pg_depend` check first).
4. Drop `reset_module__hr / pos / sales / costing / events` once
   `governance_modules` confirms no active row references them.

Risk: a SECURITY DEFINER view or seed function silently selects a dropped
column. Mitigation: run the dependency query before each drop; rollback is a
re-add of the nullable column.

## Wave G-9 — Signed-in end-to-end walk (blocked here)

Cannot run in this environment (external Supabase, no mintable session).
Needs a human pass with `fredrickmureti612@gmail.com` and one Loan Officer
account: sidebar/dashboard visibility, direct-URL block, approve/disburse
refusal, branch A vs branch B isolation, access-group administration refusal
for a non-admin, and audit rows for each refusal.

## Deferred (unchanged)

Infrastructure-level `invoice`/`estimate` identifiers in
`src/lib/queryKeys.ts`, `src/lib/payments/deriveInvoiceFromAllocations.ts`,
`src/lib/migration/sourceSystemPresets.ts`,
`SessionContext.invoices_count`,
`src/test/architecture/support/enumStatusLiterals.ts`,
`src/pages/reports/JournalReport.tsx`.
