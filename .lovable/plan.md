
# Payroll Reporting, Certificates & Returns — Enterprise Alignment

Two real defects, both architectural — not cosmetic:

1. **Statutory Returns**: exports are hardcoded to `csv` + `pdf` in the generator and UI. `gov_xlsx`/`gov_xml` files are already generated and uploaded (`gov_file_path`), but no button surfaces them. Adding an "XLSX button" ad-hoc would repeat the mistake.
2. **Tax Certificates (P9 / P9A)**: the KE pack stored `xlsx_binary` bindings in a shape the renderer cannot read. `cell_bindings` is an array of `{cell, kind, source}` records, but `binaryCertificateRenderer.ts` expects `cell_bindings.static` (object keyed by cell → `{token}`) and `monthly_grid.columns[].col` (not `.column`). Every P9/P9A call hits `ws.getCell(undefined…)` → 500. "Annual Earnings Statement" isn't in the pack → 404 surfaced as 422 by the UI.

Both point at the same root cause: **output formats and rendering contracts must be declared by the pack**, not assumed by application code — matching Odoo (`report.report_action` with `report_type`), SAP HCM (`HR_FORMS` with format registry), Workday (Report Writer output profiles) and Oracle HCM (BI Publisher output types per template).

---

## PART A — Pack-declared export formats (Returns + Certificates)

### A1. Data model
Add a canonical `outputs jsonb` column to both:
- `localization_pack_return_templates.outputs` — array like `[{format:'gov_xlsx', ext:'xlsx', mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename:'{code}_{period}.xlsx', role:'primary'}, {format:'pdf', role:'human_readable'}, {format:'csv', role:'audit'}]`
- `localization_pack_certificate_templates.outputs` — same shape (`xlsx_binary`, `pdf`, `csv`).

Legacy `output` scalar becomes derived (view) for backwards compatibility; a migration back-fills `outputs` from the existing `output`/`submission_format.type`. Constraint: at least one entry with `role='primary'`.

Add `payroll_return_runs.artifacts jsonb` = `[{format, path, size, sha256, generated_at}]`. Keep `csv_path`/`pdf_path`/`gov_file_path` writes for one release as read-mirrors; new code reads `artifacts`.

### A2. Generator changes
- `generate-statutory-return`: iterate `template.outputs`, dispatch each to the right writer (`csvWriter`, `reportPdfGenerator`, `govFileWriter` for gov_csv/gov_xlsx/gov_xml). Upload each, push into `artifacts`. Drop the hardcoded `output === 'csv' | 'pdf' | 'both'` branches.
- `generate-tax-certificate`: same — iterate `template.outputs`; `xlsx_binary` and PDF renderers already exist.
- Both write a canonical filename per pack spec so gov portals accept the extension.

### A3. UI
- `ReturnsTab` and `TaxCertificatesTab` render one download button per `artifacts[i]` (label from `outputs[i].label` fallback to format), replacing the hardcoded CSV/PDF pair.
- Disabled state derives from artifact presence, not column name.

### A4. Publisher (`ReturnTemplateEditor`, certificate editor)
Add an "Export formats" section: multi-select from a registry (`format_registry` table seeded with `pdf`, `csv`, `xlsx`, `gov_csv`, `gov_xlsx`, `gov_xml`, `xml`, `edi`), per-format filename template, MIME override, role. This unblocks future statutory documents without engineering.

## PART B — Fix P9 / P9A xlsx_binary contract

### B1. Canonicalize the binding schema
Publish the shape the renderer already reads:
```
cell_bindings: {
  static: { "P4": {token:"employer.tax_pin"}, "C5": {token:"employer.legal_name"}, ... },
  monthly_grid: { start_row:15, end_row:26, columns:[{col:"B", rule_code:"basic_salary"}, ...] }
}
```
Migration rewrites the KE P9 and P9A rows in place (no pack version bump needed — same bytes, corrected metadata). Add a JSON-schema trigger on `localization_pack_certificate_templates` that rejects `kind='xlsx_binary'` rows missing `cell_bindings.static` or with `monthly_grid.columns[].col` absent.

### B2. Renderer hardening
`binaryCertificateRenderer.ts` learns to reject (not silently skip) an unknown binding shape, and supports the derived `header.title_with_year` token (currently unresolved; render as `P9 TAX DEDUCTION CARD YEAR {{fiscal_year}}`).

### B3. Missing template surface
"Annual Earnings Statement" (`AES`?) isn't registered in the KE pack. Two options, both cheap: (a) hide the button until a template exists, (b) publish a minimal `AES` template that reuses the P9 master with a different `header.title` and cell subset. Ship (a) now, defer (b) to a follow-up unless legally required — needs a one-line confirmation from you before publishing.

## PART C — Preconditions & lifecycle

Both edge functions already gate certificates on **approved payroll runs** and returns on frozen payslip lines. Add a shared precondition module (`_shared/payrollLifecycleGate.ts`) exposing `requireApprovedRuns(fy)` and `requireClosedPeriod(period)` so future artifacts can't drift. Aligns with SAP HCM (`PA30`/`PC00_M99_CIPE` gates), Workday ("Complete" run status), Odoo (`state='done'`).

## PART D — Integrity guards (tests)

- Architecture test: every certificate template with `kind='xlsx_binary'` conforms to `BinaryCertificateBody`.
- Every `outputs[i].format` must exist in `format_registry`.
- `payroll_return_runs.artifacts[]` non-empty when `status='generated'`.
- Publisher UI test: format multi-select persists round-trip.

## Out of scope

- Cross-country pack redesign — only KE pack templates are edited.
- New submission formats (EDI, MTD-style). Registry is designed to accept them without schema changes.

## Technical file map

- `supabase/migrations/*` — add `outputs`, `artifacts`, `format_registry`; back-fill; JSON-schema trigger; rewrite KE P9/P9A `cell_bindings`.
- `supabase/functions/generate-statutory-return/index.ts` — loop `outputs`.
- `supabase/functions/generate-tax-certificate/index.ts` — loop `outputs`; header token.
- `supabase/functions/_shared/pdf/binaryCertificateRenderer.ts` — schema check, derived tokens.
- `supabase/functions/_shared/payrollLifecycleGate.ts` — new.
- `src/components/payroll/ReturnsTab.tsx`, `src/components/payroll/TaxCertificatesTab.tsx` (or equivalent) — artifact-driven buttons.
- `src/features/localization/components/ReturnTemplateEditor.tsx` + certificate editor — outputs picker.
- `src/hooks/payroll/useStatutoryReturns.ts`, `useTaxCertificates.ts` — surface `artifacts`.
- `src/test/architecture/*` — new integrity tests.

Confirm and I'll implement in this order: migration → renderer/generator → UI → publisher → tests.
