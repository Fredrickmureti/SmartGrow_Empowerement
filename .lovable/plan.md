# Wave S-4 — results (2026-09-07)

## Step 1 — vocabulary fixes: DONE

- `src/types/documentTemplate.ts` L168 `template_type: 'loan_payment_receipt'`
  (this was a real type error — `'invoice'` is no longer in the union), L180
  `document_title_format: 'REPAYMENT RECEIPT'`.
- `src/hooks/useDocumentTemplates.ts` L95 fallback → `'REPAYMENT RECEIPT'`.
- `src/components/templates/DocumentTemplateBuilder.tsx` L91/L100/L326 →
  "Standard Repayment Receipt", "REPAYMENT RECEIPT, LOAN STATEMENT",
  "Please quote your loan number on every repayment."

## Step 2 — verification: PASS

`bunx tsgo --noEmit` clean; build log reports `build OK` after the edits
(the earlier `TS2322 '"invoice"'` entries are resolved).

## Step 3 — Wave G-5

Browser auth status is `external_unmanaged`, so **no signed-in browser walk is
possible** in this environment — the preview cannot mint a session. Substituted
source and database evidence.

| Check | Verdict | Evidence |
| --- | --- | --- |
| Settings vocabulary | PASS | `rg -i 'invoice\|estimate\|proforma\|credit_note\|purchase order' src/components/settings src/pages/settings src/hooks/useDocumentTemplates.ts src/components/templates` → 0 hits |
| Branch isolation | PASS | `mf_loans` / `mf_loan_applications` / `mf_repayments` SELECT+UPDATE policies are branch-qualified; INSERT `WITH CHECK mf_can(business_id, branch_id, <module>, 'create')`; `mf_can` delegates to `user_has_module_permission_in_branch` |
| Loan Officer cannot approve/disburse | PASS | `permission_group_rules`: Loan Officer → loans `can_read` only (`can_approve=false`, `can_pay=false`, `can_write=false`); applications create/write only |
| Branch Manager scope | PASS | approve limited to `applications`; loans write only, no approve/pay; all evaluated per-branch |
| Self-approval refusal on lending | **FAIL — enforcement gap** | see below |

### The gap (next wave, needs a migration)

`governance_action_registry` registers `loan.approve` (`mf_loan_applications`),
`loan.disburse` / `loan.restructure` / `loan.write_off` (`mf_loans`),
`repayment.reverse` and `reversal.loan_repayment` (`mf_repayments`), **but no
`sod_*` guard trigger exists on any `mf_*` table** — `pg_trigger` shows guards
only on `approval_history`, `approval_rules`, `bank_accounts`, `expenses`,
`journal_entries`, `payments`. So the same officer can currently approve,
disburse, write off or reverse their own lending record; the catalogue entry is
declarative only.

Fix (Wave G-6): add `sod_mf_loan_applications_guard`,
`sod_mf_loans_guard` and `sod_mf_repayments_guard` `BEFORE UPDATE` triggers
calling `governance_assert_not_self` with the registered action keys, mirroring
`guard_journal_entry_self_approval`. Then re-run
`src/test/architecture/sod-coverage.test.ts` (which should be extended to
require a guard for every `mf_*` subject_table in the registry) and repeat the
refusal test.

## Deferred (unchanged)

`reset_module__hr/pos/sales/costing`; dropping `businesses.invoice_prefix` /
`estimate_prefix` / `bill_prefix` and `branches.invoice_prefix_suffix` /
`default_warehouse_id`; the infrastructure-level `invoice`/`estimate`
identifiers in `src/lib/queryKeys.ts`,
`src/lib/payments/deriveInvoiceFromAllocations.ts`,
`src/lib/migration/sourceSystemPresets.ts`, `BusinessContext`/`BranchContext`
column mirrors, `SessionContext.invoices_count`,
`src/test/architecture/support/enumStatusLiterals.ts`,
`src/pages/reports/JournalReport.tsx`.

## Do NOT repeat

Access-group seeding, governance registry parity, module registry pruning and
the settings/document/email vocabulary rewrite are all complete and verified.
