# Research: Payroll Accounting, Statutory Remittances, Certificates & Documents

Source: sub-agent investigation `sub_x4r03pmt`. Verified read-only against current codebase. Input for chapters `08-payroll-accounting.md`, `09-statutory-remittances-certificates.md`, `10-payroll-documents.md`.

## 1. GL Posting Architecture

| Layer | Object | Role |
|---|---|---|
| DB trigger | `trg_default_account_settings_payroll_role` on `default_account_settings` | Primary gate (ADR-0022): rejects mapping writes that violate role rules |
| DB function | `_payroll_assert_mapping_role(key, account)` (SECURITY DEFINER) | Called by trigger. Enforces: `salary_expense`/`*_employer_expense` → expense type; `*_payable` → liability type; no COGS; no header accounts |
| DB RPC | `payroll_validate_post_mappings(p_run_id)` | Backstop — called by `post-payroll-gl` right before JE write; catches compute→post drift |
| DB RPC | `payroll_apply_proposed_mappings(org, business, accept[])` | Only legitimate bulk writer to `default_account_settings` for payroll keys |
| DB RPC | `payroll_create_and_map_account(org, business, key, name, type)` | Provision CoA row + map it atomically |
| Edge fn | `post-payroll-gl` | Orchestrator; never writes `default_account_settings` directly |
| Client hook | `usePayrollGL` (`src/hooks/usePayrollGL.ts`) | Preflight `validate_payroll_run_mappings` then invoke edge fn |

Mapping resolution order (`post-payroll-gl/index.ts` ~175-195): org-level first, business-level overrides (`business_id` match wins). Keys are lowercase `setting_key` derived from `payslip_lines.rule_code` at post time — never hardcoded country names (ADR-0036 I1/I2).

## 2. Accounting Events (Dr/Cr by account role)

### Event 1 — Gross Pay / Deductions / Net Pay (`post-payroll-gl`)
Invoked from `src/hooks/usePayrollGL.ts`. JE narration (ADR-0020):
- `reference` = `payroll_runs.payroll_number`
- `description` = `"Payroll <#> - <N> employees"`
- `source_type='payroll'`, `source_id=payroll_run_id`

Lines:
```
DR  salary_expense              totalGross        "Payroll <#> - Salary Expense"
CR  <rule_code>_payable         employeeTotal     "Payroll <#> - <label>"   (per deduction type)
CR  net_salary_payable          totalNet          "Payroll <#> - Net Pay"
```
Balance check (gross = Σ deductions + net) before employer lines:
```
DR  <rule_code>_employer_expense  employerTotal   "Payroll <#> - Employer <label>"
CR  <rule_code>_payable           employerTotal   "Payroll <#> - Employer <label> Payable"
```

Amounts source: `payslip_lines` (`rule_code`, `category`, `employee_amount`, `employer_amount`) — never legacy country columns.

Idempotency: `journal_entries` queried for `source_type='payroll'` + `source_id` + `status≠'voided'`. If found → `{ journal_entry_id, already_posted:true }`.
Fiscal period lock: `fiscal_periods.status='closed'` overlapping period → 409.
SoD gate: `user_can_post_payroll(_user_id,_org_id,_run_id)` RPC — poster cannot be creator or approver.
Post-effect: `payroll_runs.status='posted'`, `posted_by`, `posted_at`. `payroll_liabilities` upserted via `uq_payroll_liabilities_run_rule` (`payroll_run_id, rule_code`).

Liability fields written: `authority_name` (from `localization_pack_remittance_schedules.authority_name` or label fallback), `label`, `country_code`, `period_start/end`, `due_date` (RPC `compute_remittance_due_date`), `original_amount`, `paid_amount=0`, `outstanding_amount`, `status='open'`, `liability_account_id` (RPC `resolve_liability_account_for_rule`, fallback `<rule_code>_payable` mapping).

### Event 2 — Net Pay Cash (`post-payroll-payment-gl`)
JE: `reference=batch.batch_number`, `description="Payroll payment <batch#> (run <#>)"`, `source_type='payroll_payment'`, `source_id=batch.id`.
```
DR  net_salary_payable     batch.total_amount    "clear net pay liability"
CR  bank_account.account_id  batch.total_amount  "bank disbursement"
```
Idempotency: `payroll_payment_batches.payment_journal_entry_id`. SoD: `user_can_pay_payroll`.
Post-effects: `payment_batch_items.status='paid'`; `payslips.status='paid'`; if all run payslips paid → `payroll_runs.status='paid'`.

### Event 3 — Statutory Remittance (`post-remittance-payment`)
Called from `src/pages/hr/RemittanceTracking.tsx`. JE: `reference=ref_number`, `description="Statutory remittance payment - <authority>"`, `source_type='payroll_remittance_payment'`, `source_id=null` (header id not yet known).
```
DR  liability_account_id   alloc.amount   "Remittance <authority> - <label>"
       (aggregated per liability_account when liabilities share GL account)
CR  bank_account_id        total          "Remittance payment <authority>"
```
Validation: all `liability_id` same `business_id`+`authority_name`; `status ∉ {paid,void,legacy_paid}`; `alloc.amount ≤ outstanding_amount`; bank must be asset/bank/cash type; every liability must have `liability_account_id`.
Post-effects: insert `payroll_remittance_payments` header + `payroll_remittance_payment_allocations`. Trigger `trg_recompute_liab_on_alloc` recomputes per liability; flips to `'paid'` when outstanding=0. Mirrors single-source liability to legacy `payroll_remittances`.

### Event 4 — Loan Disbursement (`post-loan-disbursement`)
JE: `description="Loan disbursement — <loan_number>"`, `reference=loan.loan_number`, `source_type='loan_disbursement'`, `source_id=loan.id`.
```
DR  loan_types.gl_receivable_account_id           principal
CR  loan_types.gl_disbursement_clearing_account_id  principal
```
Account source: `loan_types` columns (not `default_account_settings`). Idempotency: `source_type='loan_disbursement'`+`source_id`. Note: inserts directly into `journal_entries`/`journal_entry_lines` (pre-Wave-3 pattern, not `post_journal_entry_atomic`).

### Event 5 — Loan Settlement / Write-off (`post-loan-settlement`)
Normal: `"Loan settlement — <#>"` / Write-off: `"Loan write-off — <#>"`. `source_type='loan_settlement'`.
```
Normal:
  DR  gl_disbursement_clearing_account_id   outstanding_balance
  CR  gl_receivable_account_id              outstanding_balance
Write-off:
  DR  default_account_settings['loan_writeoff_expense'] (fallback 'salary_expense')  amount
  CR  gl_receivable_account_id                                                        amount
```

### Event 6 — Reversal (`reverse-payroll` → `payroll_reverse_run_atomic`)
Delegated to RPC (single tx). Responsibilities: negated sub-ledger run + negated payslips; terminal status flip; canonical GL void (negating JE lines); `payroll_reclassification_audit` rows; audit log.
Idempotency: already reversed → existing envelope `{idempotent:true}` (hint `ALREADY_REVERSED` → 409).

| RPC hint | HTTP |
|---|---|
| `ALREADY_REVERSED` | 409 |
| `INVALID_STATE` / `IS_REVERSAL` | 409 |
| `MISSING_GL_ENTRY` | 422 |
| `PERIOD_LOCKED` | 409 |
| `NO_PAYSLIPS` | 422 |
| `42501` permission | 403 |

### Event 7 — Retro Pay
Not yet shipped as standalone JE (M-PAY-6 in `docs/audit/2026-06-06-hr-payroll-reaudit-v2.md`). Retro amounts currently flow through normal `payslip_lines` (`category='retro'`) in the same run.

### Event 8 — Reclassification JE
RPC `payroll_generate_reclassification_je(p_run_id)` (ADR-0022). Audit table `payroll_reclassification_audit`. Lock `payroll_runs.reclassification_journal_entry_id` — a run can only be reclassified once. JE is a balanced correction moving COGS-targeted payroll debits to the current salary expense account.

## 3. JE Numbering
RPC `get_next_journal_entry_number(_org_id)` (from `je_number_sequences`). Fallback `JE-${Date.now()}` only on RPC failure. ADR-0020: `_reference` is source doc human number; `_description` is `"<Kind> <number> (<qualifier>)"`. UUID concatenation forbidden — enforced by `src/test/architecture/je-description-no-uuid.test.ts`.

## 4. Drift Monitoring (ADR-0032)
Table `control_account_drift_log` append-only (`organization_id, account_id, gl_balance, subledger_balance, drift, snapshot_at`). RLS: org members SELECT; only `service_role` INSERT. Index `(organization_id, snapshot_at DESC)`.
Cron `snapshot_control_account_drift_daily` at `0 2 * * *` UTC via `pg_cron` calls `snapshot_control_account_drift()`; inserts only when `abs(drift)>0.005`.
Alert escalation: `finance_alert_drift_streaks` tracks consecutive daily drift per account/org; notifications tail `snapshot_at > now()-interval '1 day'`.
Reference incident: `docs/audit/2026-05-25-payroll-drift-incident.md` (Accrual Traders COGS, JE-00002, ~60k mis-debited to 5100) — closed by ADR-0022 trigger gate.

## 5. Statutory Remittance Lifecycle

### Phase 1 — Accrue (at GL post)
`post-payroll-gl` upserts `payroll_liabilities` (`uq_payroll_liabilities_run_rule`):
- `due_date` ← `compute_remittance_due_date(org, business, country_code, rule_code, period_end)`
- `authority_name` ← `localization_pack_remittance_schedules.authority_name` (preferred) or label
- `liability_account_id` ← `resolve_liability_account_for_rule(...)` then `<rule_code>_payable` fallback
- `status='open'`, `paid_amount=0`, `outstanding_amount=original_amount`
Country resolution: `payroll_statutory_rules.country_code` per `rule_code`; fallback to most-recent `installed_localization_packs` country.

### Phase 2 — Schedule/Track
`payroll_liabilities` is single source of truth. `period_start/end`, `due_date`, `status ∈ {open, partial, paid, void, legacy_paid}`. `payroll_liability_sources` links payslip contributions per liability (traceability).

### Phase 3 — Pay
Body to `post-remittance-payment`:
```
{ organization_id, business_id, authority_name, payment_date, bank_account_id,
  payment_method, reference_number, proof_url, notes,
  allocations: [{liability_id, amount}] }
```
JE posted (Dr liabilities / Cr bank). `payroll_remittance_payments` + `payroll_remittance_payment_allocations` inserted.

### Phase 4 — Allocate (trigger)
`trg_recompute_liab_on_alloc` AFTER INSERT on allocations:
- `paid_amount += alloc.amount`
- `outstanding_amount = original_amount − paid_amount`
- `status` → `'partial'` or `'paid'`
Legacy mirror: when single-source liability fully cleared, legacy `payroll_remittances.status='paid'`.

### Phase 5 — Certificate / Return
See §6 / §7.

### Country-agnosticism
No country code in engine paths. Countries enter only via:
- `payroll_statutory_rules.country_code` (pack-seeded)
- `localization_pack_remittance_schedules` (pack-seeded)
- `installed_localization_packs` (tenant install)
Guard: `src/test/architecture/no-hardcoded-country-payroll.test.ts`.

## 6. Tax Certificates Pipeline

### `generate-tax-certificate`
Invoked from `src/hooks/payroll/useTaxCertificates.ts`. Body: `{organization_id, business_id, template_code, fiscal_year, employee_ids[], branch_id?, regenerate?}`.

Resolution:
1. Template from `localization_pack_certificate_templates` matching installed pack OR `pack_id IS NULL` (generic fallback), keyed by `template_code`.
2. Org overrides merged from `payroll_certificate_template_overrides`.
3. YTD via RPC `payroll_employee_ytd_rollup(p_year, p_employee_id)` (aggregates `payslip_lines` by `rule_code`).
4. Token rendering: `_shared/renderTokens.ts` (ADR-0036 I5). Unresolved → `‹unresolved: token›` + `payroll_diagnostics` row.
5. PDF via `generateReportPdf` (`_shared/reportPdfGenerator.ts`).
6. Paper size locked `assertStatutoryPaper("a4")` — tenant print policy cannot override.

Storage: `documents` bucket, path `<org_id>/payroll/tax-certificates/<year>/<template_code>/<serial>.pdf`. Serial `<template_code>-<year>-<emp[0:8]>-<base36 ts>`.

Idempotency: `regenerate=false` + existing `issued` row → returned in `skipped[]`.
Regeneration: flip prior to `superseded`; keep both for audit.

Table `payroll_tax_certificates`: `organization_id, business_id, branch_id, employee_id, template_code, template_pack_id, fiscal_year, payload (jsonb), pdf_path, serial_number, status ∈ {issued,superseded}, generated_by, batch_id`.

### `download-tax-certificate`
Auth: JWT + `user_has_module_permission(_user, _org, _business, 'payroll', 'read')`.
Loads `payroll_tax_certificates.pdf_path` → 60s signed download URL from `documents` bucket → `{signedUrl, filename, certificate_id}`.

## 7. Statutory Return Pipeline (`generate-statutory-return`)
Body: `{organization_id, business_id, template_code, period_start, period_end, branch_id?, regenerate?}`.

Resolution:
1. Template `localization_pack_return_templates` (pack match or NULL fallback) + `payroll_return_template_overrides` per-org column overrides.
2. `filters.rule_codes[]` drives `payslip_lines` query (`rule_code IN (...)`).
3. Per-employee aggregates: `sum_employee_amount`, `sum_employer_amount`, `taxable = payslips.taxable_income ?? gross_pay`.
4. Projected per `columns[]`. `source` values: `employee.<field>` | `sum_employee_amount` | `sum_employer_amount` | `sum_taxable_amount`.
5. Reconciliation: if `template.body.reconciliation.rule_code` set, compare `payroll_liabilities.original_amount` sum to projected total → `{expected, actual, diff}`.
6. Output CSV and/or PDF per `template.output ∈ {csv,pdf,both}`.
7. Paper lock `assertStatutoryPaper("a4")` for PDF.

Storage: `documents/payroll/statutory-returns/<org_id>/<year>/<template_code>/<serial>.csv|pdf`.

Table `payroll_return_runs`: `organization_id, business_id, branch_id, template_code, template_pack_id, period_start/end, payload (jsonb), csv_path, pdf_path, serial_number, status ∈ {generated, filed, superseded}, generated_by`.

## 8. Payroll Documents Pipeline

### `generate-payslip-pdf`
Body: `{payslip_id}` OR `{payroll_run_id, employee_id}`. Auth: JWT; self-service bypass (employee's own `user_id`) OR `payroll.read`.

Data: `payslips` ⋈ `employees` (`departments!employees_department_id_fkey`, `job_positions`) ⋈ `payroll_runs`. Branding via `getOrganizationBranding(supabase, org_id)`.
Lines: `payslip_lines` via `_shared/payslipClassifier.ts` + `adaptBracketBreakdown`. Grouping `EARNING_CATS / DEDUCTION_CATS / EMPLOYER_CATS` (ADR-0036 I9).
Statutory IDs: `payroll_settings.payslip_show_employer_statutory_ids` flag (default OFF); employer from `organization_statutory_identifiers`; employee from `employee_statutory_identifiers`.
PDF via `generateReportPdf`. Returns raw `application/pdf` (not uploaded).

### `generate-payroll-document`
Document types: `payslip | payroll_summary_pdf | payroll_summary_excel | payroll_register | bank_payment_file`. All amounts from `payslip_lines`.

| Type | Output |
|---|---|
| `payslip` | PDF (delegates) |
| `payroll_summary_pdf` | PDF (run totals) |
| `payroll_summary_excel` | CSV (employee summary) |
| `payroll_register` | CSV per-employee × per-line |
| `bank_payment_file` | CSV (`employee_number, bank_account_number, bank_code, net_pay`) |

## 9. Payslip Immutability
Triggers `trg_payslips_immutable_upd` (BEFORE UPDATE) and `trg_payslips_immutable_del` (BEFORE DELETE) → `payslips_immutability_guard()`. Allow-list for payment batch: `status`, `paid_at`, `payment_reference`, `updated_at`.

Country-agnosticism (`supabase/tests/payslip_immutability_country_agnostic_test.sql`):
1. Function exists.
2/3. Both triggers attached.
4. Function body must NOT contain any of `paye, nhif, shif, nssf_employee, nssf_employer, housing_levy, ahl, nita, sdl, paye_uk, paye_ni, irpf, irpef`.

Sibling immutability guards: `payroll_runs_immutability_guard`, `payslip_lines_immutability_guard`.

## 10. Portal Exposure
`src/pages/me/MyPayslips.tsx` (`/me/payslips`): `useCurrentEmployee`; renders `<EmployeeLinkRequired/>` if unlinked.
Query: `payslips.eq(employee_id, currentEmployee.id)` joined to `payroll_runs`.
Download: `generate-payslip-pdf` with `payslip_id` (self-service bypass in edge fn).
Detail: `<PayslipDetailDialog>` consumes `payslip_lines` via `payslip_header` RPC + `payslip_lines` (ADR-0036 I9).
Tax certificates: `useTaxCertificates.ts` queries `payroll_tax_certificates`; download via `download-tax-certificate` (60s signed URL).

## 11. Statutory Identity Tables

| Table | Owner | Purpose |
|---|---|---|
| `employee_statutory_identifiers` | HR | Per-employee identifiers keyed by `identifier_type` from `country_statutory_catalog` |
| `organization_statutory_identifiers` | Organization | Employer registration numbers (printed on payslips when `payslip_show_employer_statutory_ids=true`) |
| `country_statutory_catalog` | Platform/pack | Master valid identifier types per country; drives required-field validation |

ADR-0036 I3: payroll never owns identifier input UI; only reads. Required-field logic in employee profile must not branch on country code (driven by `pack_requirements` per I4).

## 12. Architecture Guards

| Test | What it enforces |
|---|---|
| `post-payroll-gl-validates-mappings.test.ts` | Edge fn must call `payroll_validate_post_mappings` before `post_journal_entry_atomic` |
| `payroll-mapping-trigger-guard.test.ts` | `trg_default_account_settings_payroll_role` + `_payroll_assert_mapping_role` exist and unweakened |
| `no-hardcoded-country-payroll.test.ts` | Scans `post-payroll-gl`, `reverse-payroll`, `post-remittance-payment` for country literals |
| `payroll-no-default-accounts-reads.test.ts` | Payroll must not read legacy `default_accounts` table |
| `payroll-completion-guards.test.ts` | Entitlement + fiscal-period lock + SoD gate on `post-payroll-gl` |
| `no-client-write-payroll-remittances.test.ts` | No direct client write to `payroll_remittances` |
| `je-description-no-uuid.test.ts` | No UUID concatenation in JE description/reference |
| `payslip_immutability_country_agnostic_test.sql` | Immutability guard exists, bound, no country tokens |
| `payroll_mapping_trigger_test.sql` | pgTAP valid/invalid INSERT/UPDATE paths |
