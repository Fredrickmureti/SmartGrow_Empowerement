
## The concern, restated

The P9 you attached proves the point: the platform-side gates (schemas, legal metadata, publish lint, upgrade fan-out) are in place, but the **document that actually reaches the tenant is still a generic report table with a title stapled on top**. Looking at your PDF:

- No employer identity band (PIN, address, tax office) — just "Joshua Holdings / KE" borrowed from the report header.
- No employee identity band (name, KRA PIN, employee number, period of service).
- Duplicate "Month" column, broken kerning ("M onth", "P9 - Tax Deduction Card").
- 11 of 12 monthly rows are zeros while the footer claims Total employee deductions 121,327.26 — data projection is partially wired.
- No relief summary block, no signature block, no statutory footnote (Income Tax Act CAP 470 §37) — the ADR-0060 sections exist in schema but never render as visual bands.
- Bottom disclosure "Tax Certificate · P9 · FY 2026" is the report-runner footer, not a certificate signature area.

## Root cause

`supabase/functions/generate-tax-certificate/index.ts` reads the rich `body.sections[]` (employer_header, employee_header, fiscal_period_band, monthly_breakdown, ytd_table, totals, relief_summary, signature_block, statutory_footnote) and then **flattens every section into a single `ReportPdfPayload`**: one `columns[]`, one `rows[]`, and a `summaryRows[]` of tiny label/value pairs. `generateReportPdf` is a spreadsheet renderer — it has no concept of an identity band, a period band, or a signed footer, so those sections either collapse into the summary strip or disappear entirely.

Secondary issues surfaced by the same PDF:
- `payroll_employee_monthly_breakdown` returns partial rows (only one month populated) — the projector doesn't fan a payroll_employee_ytd snapshot across 12 months when per-month rows are absent.
- `accountantMono` theme font kerning drops space glyphs mid-word on some sizes.
- Editor preview and runtime output diverge — publishers can't see the shallowness before shipping.

## What to build

### 1. Dedicated certificate renderer (`_shared/pdf/certificateRenderer.ts`)
Consumes `body.sections[]` directly and draws one visual block per section type using the existing PdfBuilder primitives — never routes through `generateReportPdf`.

```text
┌────────────────────────────────────────────────┐
│  EMPLOYER                    P9 — TAX DEDUCTION│
│  Joshua Holdings Ltd         CARD              │
│  PIN P051234567X · KRA West  Fiscal Year 2026  │
├────────────────────────────────────────────────┤
│  EMPLOYEE                                      │
│  Jane Doe · PIN A012345678B · Emp# 4421        │
│  Period of service: 01 Jan 2026 – 31 Dec 2026  │
├────────────────────────────────────────────────┤
│  MONTHLY BREAKDOWN                             │
│  Mo  Basic  Gross  NSSF  SHIF  AHL  ...  PAYE  │
│  Jan …                                         │
├────────────────────────────────────────────────┤
│  YTD TOTALS         RELIEF SUMMARY             │
├────────────────────────────────────────────────┤
│  STATUTORY FOOTNOTE (Income Tax Act §37)       │
│  SIGNATURE: employer ______   date ______      │
└────────────────────────────────────────────────┘
```

Each section is a first-class draw function (`drawEmployerHeader`, `drawEmployeeHeader`, `drawFiscalPeriodBand`, `drawMonthlyBreakdown`, `drawYtdTable`, `drawTotalsBand`, `drawReliefSummary`, `drawSignatureBlock`, `drawStatutoryFootnote`) with its own vertical rhythm, its own typography weight, and its own rule lines. Unknown section types raise 422 (already enforced upstream).

### 2. Fix monthly projection
`payroll_employee_monthly_breakdown` must return 12 rows per rule_code even when a month has zero activity — driven by fiscal calendar, not by presence of payslip data. Current partial-row output is why 11 rows read "0 0 0 0…".

### 3. Fix kerning in `accountantMono`
Titles like "P9 - Tax Deduction Card" and "M onth" show dropped spaces. Switch the theme to a font that ships with a full space glyph at all sizes (Helvetica bundled with pdf-lib, or embed a WOFF subset with space preserved) and add a golden-image test.

### 4. WYSIWYG publisher preview
`CertificateTemplateEditor`'s preview panel must call the **same** `certificateRenderer` (compiled for browser via pdf-lib) so what the publisher sees in the editor is exactly what the tenant will get. Kills the "looked fine in the editor, shallow in production" gap for good.

### 5. Publish-time visual QA
Extend `lint-localization-pack` to render a synthetic P9 with fixture data, screenshot it, and reject publish if:
- Any required section from the template body renders as empty (no rows, no text).
- Total width of any section exceeds page width.
- The rendered PDF is under a byte-size floor (proxy for "shallow output").

### 6. Backfill the Kenya P9 template
Update the seeded KE P9 template body to include all sections the renderer now supports (employer_header with PIN/tax-office tokens, employee_header with KRA PIN, fiscal_period_band with period-of-service, relief_summary with personal + insurance, signature_block, statutory_footnote citing CAP 470 §37). Ship as a `pack_upgrade_proposal`, not a forced overwrite.

## Technical notes

- `generateReportPdf` stays as-is — reports still need it. Certificates simply stop using it.
- No schema changes. The `certificate_template_v2` schema already declares the section whitelist; this is a renderer + data-projection + preview change.
- Tests: golden PDF snapshot per KE template section, `render_refusal_test.ts` extended to assert visual bands exist for a well-formed body.
- Rollout: new renderer behind a `pack_versions.metadata.renderer = "v2"` flag; existing issued P9s under `payroll_tax_certificates` are historical and untouched.

## Out of scope

- Certificate of Service layout polish (same renderer, follow-on content pass).
- Non-KE country packs — same infrastructure, different template bodies.
- Multi-language rendering.

## Deliverables

1. `_shared/pdf/certificateRenderer.ts` + per-section draw components.
2. `generate-tax-certificate` switched to the new renderer.
3. Monthly projection RPC returns full 12-row grid.
4. Font/kerning fix in `accountantMono` + regression test.
5. `CertificateTemplateEditor` preview uses the same renderer.
6. `lint-localization-pack` visual-QA gate.
7. KE P9 template body upgraded via `pack_upgrade_proposals`.
