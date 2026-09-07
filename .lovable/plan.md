# Authorization convergence — status (2026-09-07)

## Completed and verified (do NOT repeat)

- Access-group seeding, governance registry parity, module registry pruning,
  settings/document/email vocabulary rewrite in `src/`.
- Wave S-4 vocabulary fixes (`documentTemplate.ts`, `useDocumentTemplates.ts`,
  `DocumentTemplateBuilder.tsx`); `tsgo --noEmit` clean.
- Wave G-5 checks: settings vocabulary clean, branch isolation on `mf_loans` /
  `mf_loan_applications` / `mf_repayments`, Loan Officer cannot
  approve/disburse, Branch Manager scope — all PASS.
- `permission_group_rules.module` values are microfinance-only.

## Wave G-6 — lending self-action guards — DONE

Three small migrations added `BEFORE UPDATE` guards calling
`governance_assert_not_self`, organization resolved via
`businesses.organization_id`:

- `sod_mf_loan_applications_guard` — `loan.approve` on transitions to
  `approved` / `rejected`; subject = `submitted_by` ?? `created_by`.
- `sod_mf_loans_guard` — `loan.disburse` / `loan.restructure`
  (`pending_disbursement → active`, keyed on `lineage_kind`) and
  `loan.write_off` (`→ written_off`).
- `sod_mf_repayments_guard` — `repayment.reverse` (`→ reversed`);
  subject = `received_by` ?? `created_by`.

EXECUTE revoked from PUBLIC/anon/authenticated on the new functions.
Coverage locked by `src/test/architecture/sod-trigger-coverage.test.ts`
(registry snapshot → guarded-table snapshot); passes together with
`governance-action-registry-parity.test.ts`.

## Wave G-7 — app catalogue — DONE

`platform_apps` already had every ERP row `is_available=false`,
`is_visible_in_signup=false`; only leftover **active installs** for `sales` and
`purchases` remained — set `is_active=false` (rows kept for history).
`src/features/resources/appOptions.ts` rewritten to Clients, Lending,
Collections, Finance, Reports.

## Wave G-8 — legacy settings retirement — DONE

1. Stopped reading: `BusinessContext` (`invoice_prefix`, `estimate_prefix`,
   `bill_prefix` removed from `Business` + `CreateBusinessInput`),
   `BranchContext` (`invoice_prefix_suffix`, `default_warehouse_id` removed
   from type, select list and identity mapping).
2. `pg_depend` check returned no view/rule dependency.
3. Dropped `businesses.invoice_prefix / estimate_prefix / bill_prefix /
   sales_return_prefix / require_bill_approval /
   allow_duplicate_vendor_invoice_numbers /
   block_bill_approval_on_match_exception / payroll_overtime_multiplier /
   payroll_standard_hours_per_day / payroll_standard_working_days /
   payroll_self_approval_policy` and `branches.invoice_prefix_suffix /
   default_warehouse_id`.
4. Dropped `reset_module__hr / pos / sales / costing / events`
   (`governance_modules` references none of them).

`tsgo --noEmit` clean afterwards. The only remaining match for those names is
the FORBIDDEN regex in
`src/test/architecture/no-org-identity-reads.test.ts` — intentional guard.

## Wave G-9 — signed-in end-to-end walk — STILL BLOCKED

External Supabase, no mintable session in this environment. Needs a human
pass with the owner account plus one Loan Officer account: sidebar/dashboard
visibility, direct-URL block, approve/disburse refusal, branch A vs B
isolation, access-group administration refusal, and an audit row per refusal.

## Known pre-existing test failures (not caused by this work)

12 architecture suites fail on inherited AccrualFlow migrations/SPA rules:
`gl-totals-single-source`, `bank-feeds-business-level-gating`,
`banking-business-level-gating`, `currency-ratchet`,
`finance-settings-permission-gated`, `je-description-no-uuid`,
`no-conditional-radix-overlay`, `no-tanstack-router-in-spa`,
`pgcrypto-extension-prefix`, `po-billed-quantity-single-writer`,
`single-audit-trigger-per-table`, `sql-businesses-currency-column`.

## Deferred (unchanged)

Infrastructure-level `invoice`/`estimate` identifiers in
`src/lib/queryKeys.ts`, `src/lib/payments/deriveInvoiceFromAllocations.ts`,
`src/lib/migration/sourceSystemPresets.ts`, `SessionContext.invoices_count`,
`src/test/architecture/support/enumStatusLiterals.ts`,
`src/pages/reports/JournalReport.tsx`.
