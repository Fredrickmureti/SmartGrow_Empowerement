
# Kenya P9 — pixel-exact replacement via the Localization Pack

## Decisions from clarifications
- **Output**: both XLSX and PDF stored per issuance.
- **Master quirks**: fix the SUM range (rows 15–26), set the year header dynamically, blank the sample employer/employee cells. Every label, heading, section title, column letter, note, merge, border, colour, column width, row height, print setup stays byte-identical to the upload.
- **Column mapping**: proposed below; encoded in the pack, not the engine.

## What exists today
- `localization_pack_certificate_templates.body` is a JSON section-list (ADR-0060 v2). Renderer: `_shared/pdf/certificateRenderer.ts` draws sections via pdf-lib. There is no path for a binary Office template and no XLSX writer.
- Publisher UI (`TemplateEditor`) only supports the JSON section schema.
- `generate-tax-certificate` writes one artefact (PDF) to `documents/<org>/payroll/tax-certificates/<year>/<code>/<serial>.pdf`.
- KE P9 currently lives as a `sections[]` body — it cannot reproduce the KRA layout (18 columns, 55 merges, sub-header row for E1/E2/E3, employer footer block, P9A legal notes).

## Target architecture

```text
Localization Pack (KE, v-next)
  └─ certificate_template rows have `computation_kind = 'xlsx_binary'`
     ├─ body.master_asset       → storage path to the .xlsx master
     ├─ body.master_sha256      → integrity pin
     ├─ body.cell_bindings[]    → { cell | range, token, format? }
     ├─ body.year_bindings[]    → { cell, token: "period.year" } etc.
     └─ body.output = ['xlsx','pdf']

Publisher
  └─ new "Binary template" tab lets a publisher upload the .xlsx,
     preview it, and author cell_bindings against `pack_token_registry`.

Resolver (unchanged public shape)
  └─ generate-tax-certificate picks the template, coalesces overrides
     (existing Stage-C flow), then dispatches by computation_kind:
        v2          → existing sections renderer
        xlsx_binary → new BinaryCertificateRenderer

BinaryCertificateRenderer (new)
  1. Load master.xlsx from Storage (cached by sha256).
  2. Fill cells / ranges from resolved payload using ExcelJS (Deno-compatible).
     Merges, borders, fills, fonts, column widths, row heights, page setup,
     print area, print titles are all inherited from the master — we only
     write values into existing cells.
  3. Recalculate formula cells via ExcelJS's built-in calc (SUM only —
     covers this template).
  4. Emit XLSX bytes.
  5. Convert to PDF via an external converter (Gotenberg or CloudConvert
     — see "Open decision" below). Store both artefacts.
```

## Column mapping (proposed, encoded in the pack)

Row 15–26 = Jan–Dec. Values come from `payslip_lines` aggregated per employee per month, keyed by rule_code from the KE pack.

| Col | Header | Source (rule_code / derived) |
|-----|--------|------------------------------|
| A | Month | derived (Jan…Dec) |
| B | Basic Salary | `basic_salary` |
| C | Benefits – NonCash | `non_cash_benefits` |
| D | Value of Quarters | `housing_benefit` |
| E | Total Gross Pay | `gross_pay` |
| F (E1) | DC pension — 30% of A | `min(basic*0.30, actual, 30000)` (rule output) |
| G (E2) | DC pension — Actual | `pension_contribution_actual` |
| H (E3) | DC pension — 30k cap | fixed 30000 |
| I | Affordable Housing Levy | `ahl_employee` |
| J | SHIF | `shif_employee` |
| K | Post Retirement Medical Fund | `prmf_employee` |
| L | Owner-Occupied Interest | `mortgage_interest_relief_base` |
| M | Total Deductions (lower of…) | `total_relief_deductions` |
| N | Chargeable Pay (D-J) | `chargeable_pay` |
| O | Tax Charged | `paye_gross` |
| P | Personal Relief | `personal_relief` |
| Q | Insurance Relief | `insurance_relief` |
| R | PAYE Tax (L-M-N) | `paye_net` |

Header cells (P4 employer PIN, C5 employer name, C6 employee main name, C7 employee other names, P6 employee PIN) map to identity tokens already in `pack_token_registry`. Formula cells B27:R27 stay untouched; their ranges are corrected to `SUM(colXX15:colXX26)` in the master.

## Implementation phases

**Phase A — Pack schema & storage**
- Migration: new `computation_kind='xlsx_binary'` JSON Schema in `pack_rule_type_schemas` for `certificate_template`; validates `master_asset`, `master_sha256`, `cell_bindings[]`, `output[]`.
- New storage bucket convention `localization-pack-assets/<pack_id>/<version>/certificates/<code>.xlsx` (private, service-role read).

**Phase B — Master ingestion**
- Upload the (fixed) master workbook to storage.
- Insert one KE pack version (`2026.6.0`) with a new certificate template row `code='P9A'`, `computation_kind='xlsx_binary'`, body pointing to the asset, `effective_date` = current year start, superseding the current P9A row per ADR-0056 upgrade rules.
- Pack-version bump + `propose-localization-upgrades` fan-out (existing flow) surfaces the update to installed tenants; the D1 architecture test already enforces the pairing.

**Phase C — Renderer**
- Add `_shared/xlsx/binaryCertificateRenderer.ts` (ExcelJS via `npm:exceljs`).
- Route selection in `generate-tax-certificate` by `computation_kind`.
- Reuse existing resolver, override-coalesce, TEMPLATE_OUT_OF_DATE, tokens (`renderTokens`), `payroll_employee_ytd_rollup`.
- Diagnostics: unresolved bindings → `payroll_return_diagnostics` (same channel as today's `‹unresolved:›` markers).

**Phase D — PDF conversion**
- New helper `_shared/xlsx/toPdf.ts` calls the chosen converter.
- Store `<serial>.xlsx` alongside `<serial>.pdf`; update `payroll_tax_certificates` with both paths (add `xlsx_path` column via migration).
- `download-tax-certificate` gains a `format=xlsx|pdf` query param.

**Phase E — Publisher UI**
- New `BinaryCertificateEditor` in `src/features/localization/components/` — upload master, list detected named ranges/labels, bind each cell to a token from `TokenPicker`, preview by running a dry-run render against a synthetic employee.
- Register in `PackEditorShell` next to `TemplateEditor`.

**Phase F — Tests & guards**
- Architecture guard: `xlsx_binary` templates must supply `master_sha256` and `output[]`.
- Golden test: render the KE P9 for a fixture employee; assert byte-for-byte equality of merges/column widths/row heights/print setup with the master, and cell values match the fixture.
- Extend `certificate-body-change-requires-pack-version-bump.test.ts` allow-list is untouched — the new pack version enforces the rule.
- Preserve the country-agnostic guard: the renderer is generic; only the pack row is KE-specific.

## Open decision (single question I need answered before Phase D)
Deno edge functions cannot spawn LibreOffice. Two choices for the XLSX→PDF converter:
- **Gotenberg** (self-hosted or hosted): free, no per-doc cost, needs a URL + service token added via `add_secret`.
- **CloudConvert**: fully managed SaaS, needs an API key secret; per-conversion cost.

I'll default to Gotenberg (cheaper, more auditable) unless you say otherwise when I hit Phase D.

## Non-goals
- No changes to the generic payroll engine or `compute-payroll`.
- No new engine rule codes — mapping references existing KE pack outputs; anything missing is added to the pack, not the engine.
- No UI change to the employee `/me` portal beyond an extra "Download XLSX" button on the P9 row.

## Deliverables per phase
Each phase ships behind the existing pack-version gate; nothing goes live to tenants until the `2026.6.0` upgrade proposal is accepted.
