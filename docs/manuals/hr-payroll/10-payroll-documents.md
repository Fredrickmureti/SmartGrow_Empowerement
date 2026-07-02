# 10 · Payroll Documents

## Purpose
PDFs and exports an employee or accountant sees: payslips, payroll registers, bank payment files, summary reports, year-end tax certificates, statutory returns. This chapter walks each pipeline end-to-end and lists where the bytes live.

## `generate-payslip-pdf`

Input: `{ payslip_id }` OR `{ payroll_run_id, employee_id }`. Auth: JWT required.

**Self-service bypass**: if the requesting user's `auth.uid()` equals `employees.user_id` for the target payslip, the `payroll.read` permission check is skipped. Otherwise the permission is enforced.

Data assembly:
- `payslips` joined to `employees` (`departments!employees_department_id_fkey`, `job_positions`) and `payroll_runs`.
- Branding via `getOrganizationBranding(supabase, org_id)`.
- Lines from `payslip_lines` classified via `_shared/payslipClassifier.ts` + `adaptBracketBreakdown`.
- Line grouping via `EARNING_CATS / DEDUCTION_CATS / EMPLOYER_CATS` (ADR-0036 §I9).
- Statutory IDs: governed by `payroll_settings.payslip_show_employer_statutory_ids` (default OFF). Employer IDs from `organization_statutory_identifiers`; employee from `employee_statutory_identifiers`.

PDF via shared `generateReportPdf` (`_shared/reportPdfGenerator.ts`). Returned as raw `application/pdf` — **not** uploaded to storage. (The portal downloads it directly into the browser.)

## `generate-payroll-document`

Routes the request to the right format. **All amounts come from `payslip_lines`**, never legacy typed columns.

| `type` | Output | Purpose |
|---|---|---|
| `payslip` | PDF (delegates to `generate-payslip-pdf`) | Single payslip |
| `payroll_summary_pdf` | PDF | Run-level totals |
| `payroll_summary_excel` | CSV | Employee summary spreadsheet |
| `payroll_register` | CSV | Per-employee × per-line accountant view |
| `bank_payment_file` | CSV | `employee_number, bank_account_number, bank_code, net_pay` |

## Tax certificates

`generate-tax-certificate` and `download-tax-certificate` are described in Chapter 9. Reminders:
- Template lookup tries pack-specific first, then `pack_id IS NULL` generic fallback.
- Tenant overrides come from `payroll_certificate_template_overrides`.
- YTD via RPC `payroll_employee_ytd_rollup`.
- Tokens via `_shared/renderTokens.ts` (`‹unresolved: token›` + `payroll_diagnostics`).
- Paper locked to A4.
- Storage: `documents/<org_id>/payroll/tax-certificates/<year>/<template_code>/<serial>.pdf`.
- Idempotent; regeneration creates a new `issued` row and supersedes the old.

## Statutory returns

`generate-statutory-return` — Chapter 9. Reminders:
- CSV/PDF/both per `template.output`.
- Reconciliation against `payroll_liabilities.original_amount` totals.
- Storage: `documents/payroll/statutory-returns/<org_id>/<year>/<template_code>/<serial>.csv|pdf`.

## Storage conventions

All payroll documents live in the `documents` bucket. Paths:
- Payslips → not stored (rendered on demand).
- Tax certificates → `<org_id>/payroll/tax-certificates/<year>/<template_code>/<serial>.pdf`.
- Statutory returns → `payroll/statutory-returns/<org_id>/<year>/<template_code>/<serial>.csv|pdf`.

Downloads always go through edge functions (`download-tax-certificate` returns a 60-second signed URL; statutory returns are served similarly).

## Immutability guarantees

Triggers `trg_payslips_immutable_upd` / `trg_payslips_immutable_del` → `payslips_immutability_guard()`. The function body itself is **scanned for country tokens** by pgTAP test 4 in `supabase/tests/payslip_immutability_country_agnostic_test.sql` — it must contain none of `paye, nhif, shif, nssf_employee, nssf_employer, housing_levy, ahl, nita, sdl, paye_uk, paye_ni, irpf, irpef`. Sibling guards on `payroll_runs` and `payslip_lines`.

Payment-batch allowlist on `payslips`: `{status, paid_at, payment_reference, updated_at}`. Nothing else can be edited post-commit.

## Employee portal exposure

- `/me/payslips` → reads `payslips.eq(employee_id, currentEmployee.id)`, joined to `payroll_runs`. Download invokes `generate-payslip-pdf` (self-service bypass kicks in).
- Detail dialog `<PayslipDetailDialog>` consumes `payslip_lines` via the `payslip_header` RPC (ADR-0036 §I9).
- Tax certificates available via `useTaxCertificates.ts` → `download-tax-certificate` (60s signed URL).

## What's **not** exposed to employees today

- Statutory returns are organisation-level documents and are not exposed to employees.
- The raw `payroll_register` or `bank_payment_file` is finance-only.
- Yearly summary reports are gated behind `payroll.read`.

> Full evidence: `./_research/05-payroll-accounting-statutory-documents.md`.
