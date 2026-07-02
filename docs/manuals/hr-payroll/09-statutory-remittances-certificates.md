# 09 · Statutory Remittances & Certificates

## Purpose
After a payroll posts, the company **owes money to authorities** (tax, social security, levies) and must eventually **issue documentation** to employees and authorities. This chapter is the single source of truth for that whole lifecycle.

## The five phases

```text
1. Accrue         ── at GL post  ── post-payroll-gl  ── INSERT/UPSERT payroll_liabilities
2. Schedule/Track ── over time   ── /hr/RemittanceTracking page
3. Pay            ── on payment  ── post-remittance-payment ── JE + payroll_remittance_payments
4. Allocate       ── on payment  ── trigger trg_recompute_liab_on_alloc ── status update
5. Certify        ── annual/period ── generate-tax-certificate / generate-statutory-return
```

## Phase 1 — Accrue

When `post-payroll-gl` runs, for every employee/employer statutory line on `payslip_lines`, it **upserts** a row in `payroll_liabilities` (conflict key: `(payroll_run_id, rule_code)`):
- `due_date` ← `compute_remittance_due_date(org, business, country_code, rule_code, period_end)` (reads `localization_pack_remittance_schedules`)
- `authority_name` ← `localization_pack_remittance_schedules.authority_name` (preferred) or line label fallback
- `liability_account_id` ← `resolve_liability_account_for_rule(...)` then `<rule_code>_payable` mapping fallback
- `status='open'`, `paid_amount=0`, `outstanding_amount=original_amount`

Country resolution: `payroll_statutory_rules.country_code` per `rule_code`, with fallback to the most-recently installed pack's country.

## Phase 2 — Schedule & Track

`payroll_liabilities` is the single source of truth. Each row carries `period_start/end`, `due_date`, `status ∈ {open, partial, paid, void, legacy_paid}`. The page `src/pages/hr/RemittanceTracking.tsx` is where payroll officers see what's due, by authority, by period.

`payroll_liability_sources` joins each liability to the individual payslip contributions for traceability.

## Phase 3 — Pay (`post-remittance-payment`)

Body to the edge function:
```json
{ "organization_id": "...", "business_id": "...", "authority_name": "...",
  "payment_date": "...", "bank_account_id": "...", "payment_method": "...",
  "reference_number": "...", "proof_url": "...", "notes": "...",
  "allocations": [{ "liability_id": "...", "amount": 0 }] }
```
Validation: all allocations share `business_id` + `authority_name`; statuses not paid/void/legacy_paid; `alloc.amount ≤ outstanding_amount`; bank account must be asset/bank/cash; every liability must have a `liability_account_id`.

JE posted: `Dr liability accounts / Cr bank` (see Chapter 8, Event 3). Header row inserted into `payroll_remittance_payments`; allocation rows into `payroll_remittance_payment_allocations`.

## Phase 4 — Allocate (trigger)

`trg_recompute_liab_on_alloc` (AFTER INSERT on allocations):
- `paid_amount += alloc.amount`
- `outstanding_amount = original_amount − paid_amount`
- `status` → `'partial'` if partial, `'paid'` if fully cleared.

Legacy mirror: when a single-source liability is fully cleared, the legacy `payroll_remittances.status='paid'` is updated for backwards-compatible reports.

## Phase 5a — Tax certificates (`generate-tax-certificate`)

Invoked from `useTaxCertificates.ts`. Body: `{organization_id, business_id, template_code, fiscal_year, employee_ids[], branch_id?, regenerate?}`.

Resolution chain:
1. Template from `localization_pack_certificate_templates` matching installed pack OR `pack_id IS NULL` (generic) — keyed by `template_code`.
2. Org overrides merged from `payroll_certificate_template_overrides`.
3. YTD data via RPC `payroll_employee_ytd_rollup(p_year, p_employee_id)` — aggregates `payslip_lines` by `rule_code`.
4. Token rendering via `_shared/renderTokens.ts` (ADR-0036 I5). Unresolved tokens become `‹unresolved: token›` and write a `payroll_diagnostics(code='TOKEN_UNRESOLVED')` row.
5. PDF rendered by `generateReportPdf` (`_shared/reportPdfGenerator.ts`).
6. Paper size locked to **A4** via `assertStatutoryPaper("a4")` — tenant print policy cannot override.

Storage path: `documents` bucket → `<org_id>/payroll/tax-certificates/<year>/<template_code>/<serial>.pdf`.
Serial: `<template_code>-<fiscal_year>-<emp[0:8]>-<base36(now)>`.

Idempotency: `regenerate=false` + existing row with `status='issued'` → returned in `skipped[]`. Regeneration flips prior `issued` to `superseded`; both rows kept.

Table `payroll_tax_certificates`: `organization_id, business_id, branch_id, employee_id, template_code, template_pack_id, fiscal_year, payload (jsonb), pdf_path, serial_number, status ∈ {issued, superseded}, generated_by, batch_id`.

### Download (`download-tax-certificate`)
Auth: JWT + `user_has_module_permission(_user, _org, _business, 'payroll', 'read')`. Returns a 60-second signed URL to the PDF.

## Phase 5b — Statutory returns (`generate-statutory-return`)

Body: `{organization_id, business_id, template_code, period_start, period_end, branch_id?, regenerate?}`.

1. Template from `localization_pack_return_templates` (pack match or NULL fallback) + per-org overrides via `payroll_return_template_overrides`.
2. `filters.rule_codes[]` drives the `payslip_lines` query (`rule_code IN (...)`).
3. Per-employee aggregates: `sum_employee_amount`, `sum_employer_amount`, `taxable = payslips.taxable_income ?? gross_pay`.
4. Projection per declarative `columns[]`. `source` values:
   - `employee.<field>` — read from joined `employees` row.
   - `sum_employee_amount` / `sum_employer_amount` / `sum_taxable_amount` — read from aggregates.
5. Reconciliation: if `template.body.reconciliation.rule_code` is set, the sum of `payroll_liabilities.original_amount` is compared to the projected total → `{expected, actual, diff}`.
6. Output: CSV and/or PDF per `template.output ∈ {csv, pdf, both}`. PDF locked to A4.

Storage: `documents/payroll/statutory-returns/<org_id>/<year>/<template_code>/<serial>.csv|pdf`.

Table `payroll_return_runs`: `organization_id, business_id, branch_id, template_code, template_pack_id, period_start/end, payload (jsonb), csv_path, pdf_path, serial_number, status ∈ {generated, filed, superseded}, generated_by`.

## Statutory identifiers

| Table | Owner | Purpose |
|---|---|---|
| `country_statutory_catalog` | Platform/pack | Master list of valid identifier types per country; drives required-field validation |
| `organization_statutory_identifiers` | Org | Employer registration numbers (printed on payslips when `payslip_show_employer_statutory_ids=true`) |
| `employee_statutory_identifiers` | HR (per employee) | Keyed by `identifier_type` from the catalog |

Payroll never owns the identifier input UI (ADR-0036 §I3). Required-field logic must come from `pack_requirements` (§I4) — never branched on country code in the UI.

## Country-agnosticism

Country only enters via:
- `payroll_statutory_rules.country_code` (pack-seeded)
- `localization_pack_remittance_schedules` (pack-seeded)
- `installed_localization_packs` (tenant-level install)

The architecture test `src/test/architecture/no-hardcoded-country-payroll.test.ts` scans `post-payroll-gl`, `reverse-payroll`, `post-remittance-payment` for country literals and fails the build if any are found.

> Full evidence: `./_research/05-payroll-accounting-statutory-documents.md`.
