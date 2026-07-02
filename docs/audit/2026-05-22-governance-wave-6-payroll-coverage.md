# Wave 6 — Workspace Governance: Payroll/HR coverage + Clear Selected Modules deprecation

**Date:** 2026-05-22
**Status:** Shipped
**Scope:** Workspace governance registry, reset orchestration, settings/workspace UI.

## What was broken

Independent re-audit of Waves 1–5 confirmed:

1. **Payroll and HR were not in the registry.** The DB has 50+ payroll/HR tables (`payroll_runs`, `payslips`, `payroll_remittances`, `payroll_payment_batches`, `payroll_tax_certificates`, `payroll_work_entries`, `timesheets`, `attendance`, `leave_requests`, `employee_onboarding`, `employee_loans`, `employee_documents`, `employee_benefits`, `contract_compensation_components`, etc.) — none were owned by any registered module. "Wipe All Transactional Data" silently skipped every one. **This matches the user's exact bug report**: payroll runs survived a transactional wipe.

2. **`fixed_assets` module didn't own `depreciation_entries` / `depreciation_schedules`.**

3. **`pos` module didn't own `pos_held_transactions`, `pos_gift_card_transactions`, `pos_kitchen_orders`.**

4. **`ancillaries` module had `owns_tables=[]`** while its reset function silently deleted nothing (the hardcoded UI preview list referenced tables the registry didn't own).

5. **"Clear Selected Modules" remained a destructive button** in `/settings/workspace?tab=data`. The Wave 1–2 work made it transactional (FK rollback) but didn't address the *conceptual* problem: in an integrated ERP, deleting Sales without Finance orphans AR journals, deleting Inventory without GL breaks valuation, deleting Payroll without Finance leaves dangling statutory liabilities. Partial wipes are an anti-pattern.

## What shipped

### Database
- New `reset_module__payroll(uuid)` SECURITY DEFINER function — wipes 18 payroll tables in dependency order (allocations → payments → remittances → liabilities → batches → payslip lines/inputs → payslips → runs/ancillaries → work entries → YTD → tax certs → periods).
- New `reset_module__hr(uuid)` SECURITY DEFINER function — wipes 13 HR tables (timesheet audit log → timesheets → submissions → attendance corrections → attendance → leave requests/allocations → onboarding items/headers → loans → documents → benefits → compensation components).
- Extended `reset_module__pos`: now also wipes `pos_kitchen_orders`, `pos_gift_card_transactions`, `pos_held_transactions`, `cashier_registers` (each gated by `to_regclass()` so older schemas don't break).
- Extended `reset_module__ancillaries`: now actually deletes `customer_statements`, `etims_transmission_logs`, `payment_requests`, `approval_requests`.
- Updated `reset_organization_data` to call HR → Payroll → Finance in the correct order (payroll references finance journal entries via `payroll_runs.journal_entry_id`, `payroll_liabilities.journal_entry_id`, `payroll_remittance_payments.journal_entry_id`).
- Registered `payroll` and `hr` modules in `governance_modules` with proper `depends_on` (payroll → [finance, banking]; hr → [payroll]).
- Updated `owns_tables` for `fixed_assets`, `pos`, `ancillaries` to match what their teardown functions actually delete.
- Residual probe in `reset_organization_data` extended to cover payroll/payslips/timesheets/attendance/leave for post-wipe verification.

### UI
- `src/components/settings/OrgDataResetTool.tsx`: destructive "Clear Selected Modules" button **removed**. Selecting modules now renders an amber impact-analysis card explaining why partial wipes are unsafe and directs the user to the dependency-ordered "Wipe All Transactional Data" path. The category list now includes Payroll and HR so users can see their counts in the preview.

### Tests
- `src/test/architecture/governance-registry-payroll-coverage.test.ts` — snapshots the payroll/HR ownership contract + the preserved master-data allowlist.

## Verified

- Migration applied cleanly (1561 linter warnings are pre-existing, not introduced).
- Registry now reports 13 active modules including `payroll` and `hr` with full `owns_tables` arrays.

## Not in scope for Wave 6 (deferred to Wave 7)

- Unified Export Center UI (the `governance_export_jobs` table + storage bucket exist; UI binding is Wave 7).
- Live SQL coverage test (`supabase/tests/governance_registry_coverage_test.sql`) that introspects `information_schema.tables` and fails when a new transactional table isn't owned by any module.
- Background job runner for resumable exports.
- ADR 0019 amendment to formally document "partial module wipes are forbidden in integrated-ERP teardown."

## Files changed

- `supabase/migrations/<wave-6>.sql` (new) — 4 reset functions, 5 registry rows updated, orchestrator rewired.
- `src/components/settings/OrgDataResetTool.tsx` — destructive button removed, impact card added, Payroll + HR categories added.
- `src/test/architecture/governance-registry-payroll-coverage.test.ts` (new).
- `docs/audit/2026-05-22-governance-wave-6-payroll-coverage.md` (this file).
