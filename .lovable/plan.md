## What a P9 actually is

The uploaded PDF and XLSX confirm it: KRA's P9 is a **fixed, one-page regulatory form** — an 18-column grid (A-R), 12 monthly rows, YTD totals row, and a footer of legal notes. The XLSX is literally the KRA-published master with sample data typed into it. KRA requires the PDF; the XLSX is a convenience for auditors/employees who want to edit.

## What we currently have (two incompatible paths)

1. **`certificate_template_v2` structured path** (ADR 0060) — `body.sections[]` with typed section kinds (`employer_header`, `monthly_breakdown`, `ytd_table`, `totals`, `statutory_footnote`, …), rendered to PDF by `_shared/pdf/certificateRenderer.ts` + `_shared/certificateSections.ts`. Country-agnostic, pack-versioned, schema-validated at write time, publish-gated. This is the ADR-blessed enterprise path.

2. **`xlsx_binary` overlay path** — `_shared/pdf/binaryCertificateRenderer.ts` loads a KRA master workbook stored in `localization_pack_binary_assets.bytes` and overwrites cells via ExcelJS. Emits **XLSX only** (never PDF). Requires SHA-256 hydration, private bucket, admin ingest function, CDN fallbacks. KE-only special case.

The bug you saw (KRA PIN missing, P9 failing) originates in path 2, which we've been patching with more infrastructure (hydrate function, bucket, RLS) instead of asking whether it should exist.

## How Odoo does it (l10n_ke_hr_payroll, l10n_be_281, l10n_fr_dads)

- One **data source** per statutory doc (payroll declaration model), computed from payslips.
- **PDF** rendered from a QWeb template checked into the localization module — pixel-close to the regulator's form, git-versioned with the code.
- **Editable XLSX** rendered by `report_xlsx` from the same declaration model, laying out the same grid in a spreadsheet.
- No shipped binary master workbook. No runtime binary fetch. Both outputs are deterministic functions of `(pack version, employee YTD)`.

## The decision

Adopt the Odoo model, aligned to our ADR-0060 architecture:

**PDF is authoritative, structured, and pack-versioned.** Rendered by the existing `certificate_template_v2` engine. The KE P9 template gets a section list that mirrors the KRA form pixel-close (header band with PIN cells, 12-row monthly grid with columns A–O, YTD totals row, personal/insurance relief note, statutory footnote citing Income Tax Act CAP 470 §37, signature block).

**XLSX is the editable twin, rendered from the same sections + data.** New `_shared/xlsx/certificateXlsxRenderer.ts` that consumes the same `sections[]` array and YTD payload the PDF renderer uses, and writes the equivalent grid via ExcelJS. Cell formulas (`=SUM(...)`) are emitted for the totals row so it stays "editable" in the Odoo sense. Same audit trail, same pack version, no binary asset.

**Retire `xlsx_binary`.** Remove `binaryCertificateRenderer.ts`, the `xlsx_binary` branches in `generate-tax-certificate/index.ts`, the master-workbook fetcher chain, and the localization-assets hydration surface introduced this session. Migrate the current KE P9 pack row from `body.kind = "xlsx_binary"` to a v2 sectioned template in the same migration.

This collapses two paths into one, deletes the KE-only special case, kills the CDN/SHA/bucket ceremony, and gives you PDF + XLSX from a single deterministic source — exactly the parity ADR 0060 set out to achieve.

## Scope of implementation

1. **XLSX twin renderer** — `supabase/functions/_shared/xlsx/certificateXlsxRenderer.ts`. Handles each v2 section kind, mirrors the PDF layout, emits SUM formulas on the totals row for monthly grids.
2. **generate-tax-certificate** — replace the `isBinary` branch with a single path that renders PDF from `certificateRenderer.ts` and, when the template's `outputs[]` requests `xlsx`, renders XLSX from the twin renderer. Same section input for both.
3. **Kenya P9 template** — migration rewriting `localization_pack_certificate_templates` row for `KE_P9` (and `KE_P9A`) as `certificate_template_v2` with sections that reproduce the KRA layout: employer_header (name + PIN), employee_header (main name, other names, PIN), fiscal_period_band, monthly_breakdown with 15 columns matching KRA cols A–O, totals row, relief_summary (personal + insurance), statutory_footnote (CAP 470 §37 + the numbered notes on the KRA form). Bump pack version; publish lint gate passes because legal metadata is already set from prior work.
4. **Retire xlsx_binary** — delete `binaryCertificateRenderer.ts`, remove `xlsx_binary` branches from `generate-tax-certificate/index.ts`, drop `hydrate-localization-binary-asset` and the `localization-assets` bucket + RLS. Keep `localization_pack_binary_assets` the table (still used for fonts/logos if any) but no P9 row references it.
5. **Column parity for `monthly_breakdown`** — extend the section schema to allow the P9's grouped column headers (e.g. the E/E1/E2/E3 sub-header for Defined Contribution Retirement Scheme). Small additive change to `pack_rule_type_schemas.certificate_template_v2`; existing simpler templates keep working.
6. **Tests** — golden PDF test for the new KE_P9 (compare rendered PDF's text extraction against the KRA form's canonical column headers and 12 month labels), XLSX snapshot test asserting cell coordinates match the KRA grid, `certificateRenderer-parity` test extended to cover the new PDF/XLSX pair.

## Explicitly out of scope

- Pixel-identical background overlay (embedding the KRA PDF as a background and printing values on top). Odoo doesn't do this either; a faithful re-draw is what regulators accept and what our audit story requires.
- NSSF voluntary contribution column — separate work per prior turn.
- Other country certs (P9A stays in scope because it's a P9 variant; IRP5/Lohnsteuerbescheinigung stay untouched).

## Risks

- **Visual acceptance by KRA**: a re-drawn P9 must be visually recognisable. Mitigation: golden PDF review before shipping; we can screenshot compare against the uploaded KRA PDF and iterate on section geometry until they match.
- **Backward compatibility**: any already-issued P9 rendered via `xlsx_binary` stays intact — the `payroll_tax_certificates` row keeps its rendered artifact path. Only new issuances use the v2 path. Regeneration is opt-in through the standard `pack_upgrade_proposals` flow.

## Ask before I build

Confirm this direction (retire `xlsx_binary`, unify on the v2 sectioned renderer with a new XLSX twin) so I can execute the migration + renderer changes in one coherent pass. If instead you want to keep the master-workbook approach for regulatory-fidelity reasons, say so and I'll instead invest in making it emit PDF via LibreOffice headless conversion — but I'd argue that's a step away from Odoo's model, not toward it.