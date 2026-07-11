# Kenya NSSF Return — Match Official Portal Template

## 1. What the official template actually is

The attached `Payroll_Template-NSSF-Rel03.02.18.xlsx` is the NSSF byproduct upload template. It is intentionally minimal — the portal rejects anything beyond the exact shape below.

**Sheet 1 (only sheet), row 1 headers, then data rows. Nothing else.**

| Col | Header | Format | Source |
|-----|--------|--------|--------|
| A | PAYROLL NUMBER | Text (optional) | `employee.employee_number` |
| B | SURNAME | Text | `employee.last_name` |
| C | OTHER NAMES | Text | `employee.first_name` |
| D | ID NO | Text | `employee.national_id` |
| E | KRA PIN | Text | `employee.tax_id` |
| F | NSSF NO | Text, 9–10 chars, leading zeros / trailing `X` preserved | `employee.statutory_id.nssf` |
| G | GROSS PAY | Number | `sum_taxable_amount` (pensionable pay, capped at NSSF Tier II ceiling by the rule) |
| H | VOLUNTARY | Number | `sum_rule.nssf_voluntary.employee` (0 when unmapped — future-safe) |

Portal rules baked into the writer:
- No formulas, no totals row, no blank rows, no hidden rows/cols, one sheet only.
- Description/instruction rows must not appear in the submitted file.
- Cols A–F stored as text (preserves leading zeros in NSSF/ID/PIN); G–H numeric.

Current DB row (`localization_pack_return_templates` where `code='NSSF_RET'`) outputs **CSV** with 7 wrong-order columns (nssf_number first, employee_name concatenated, no ID, no KRA PIN, no payroll number, no voluntary, has totals + reconciliation footer). This is what the mission calls out — the pack is not shipping the legal template.

## 2. Architecture — no gaps, no publisher changes needed

Traced the lifecycle end-to-end. Everything required to render this template already exists:

```text
Pack publish  →  localization_pack_return_templates (versioned by pack_version_id, legal_reference, effective_date, sunset_date)
     ↓
Tenant install/upgrade  →  installed_localization_packs (auto-surfaces under Payroll → Statutory Remittances → Returns)
     ↓
Payroll Approved → payslips frozen → payslip_lines carry per-rule employee/employer amounts
     ↓
User clicks "Generate NSSF Return"  →  edge fn `generate-statutory-return`
     ↓
Loads template.body + submission_format
     ↓
Builds SourceContext per employee from payroll history (payslip_lines filtered by rule_codes)
     ↓
_shared/govFileWriter.ts  →  gov_xlsx branch  →  _shared/xlsxWriter.ts  →  bytes
     ↓
Uploaded, immutable, downloadable; regenerate re-derives from frozen payroll
```

- **Publisher (`ReturnTemplateEditor`)** already supports `output='xlsx'`, `submission_format.type='gov_xlsx'`, columns with `source` + `format`, and pack versioning. **No publisher extension required for this template** — its shape (flat row-per-employee grid) is inside the writer's current capability. Complex fixed-layout returns (SARS EMP201-style forms with merged cells and print regions) would need the `xlsx_binary` path that already exists for certificates; that is out of scope for NSSF and not needed.
- **Resolver (`returnSourceResolver.ts`)** already recognizes every source token used above — `employee.*` dynamic, `employee.statutory_id.nssf`, `sum_taxable_amount`, `sum_rule.<code>.<side>`. No resolver change needed.
- **Text formatting** for cols A–F is enforced by the writer: `xlsxWriter` will receive them as strings (source returns strings for `employee.*`), so Excel keeps leading zeros. `format` on G/H stays numeric.

## 3. Changes

### 3.1 Data change (single migration/update) — republish `KE.NSSF_RET`

Update the existing template row in-place inside a **new pack version** (immutability: prior version stays untouched for historical returns already filed against it):

1. `INSERT` a new `pack_versions` row for the KE pack (bump semver, e.g. `1.1.0`), with change note "Align NSSF return to official portal template Rel 03.02.18".
2. `INSERT` a new `localization_pack_return_templates` row for that `pack_version_id` with:
   - `code = 'NSSF_RET'`
   - `display_name = 'NSSF Monthly Byproduct Return'`
   - `authority_id` → existing NSSF-KE authority row
   - `output = 'xlsx'`
   - `legal_reference = 'NSSF Act No. 45 of 2013, Section 20 — Monthly Contribution Return'`
   - `regulation_citation = 'NSSF Portal Byproduct Template Rel 03.02.18'`
   - `effective_date = '2026-08-01'` (next filing cycle)
   - `submission_format` = the 8-column `gov_xlsx` descriptor (see §4)
   - `body.columns` mirroring the same 8 columns for the on-screen preview grid; `body.filters.rule_codes = ['nssf']`; `body.group_by = ['employee_id']`; **no totals, no reconciliation footer** (portal forbids it — the writer already skips them when unset).
3. Update `installed_localization_packs` propagation: existing `pack_upgrade_proposals` flow already auto-notifies tenants; nothing new to build.

No schema migration. No edge function code change. No publisher UI change.

### 3.2 Verification

- Deno test in `supabase/functions/generate-statutory-return/`: feed a fixture payroll run through the new template, assert output XLSX has exactly one sheet, row 1 = the 8 official headers, N data rows, no trailing totals row.
- Golden-file test: open generated bytes with `exceljs`, verify col A–F cell types are string (leading zero preserved on a `009123456X` NSSF sample), col G/H numeric.
- Manual: trigger regeneration on an existing approved payroll period; download; diff header row against attached template byte-for-byte.

## 4. Technical detail — submission_format payload

```json
{
  "type": "gov_xlsx",
  "sheet_name": "Sheet1",
  "columns": [
    { "header": "PAYROLL NUMBER", "source": "employee.employee_number" },
    { "header": "SURNAME",        "source": "employee.last_name" },
    { "header": "OTHER NAMES",    "source": "employee.first_name" },
    { "header": "ID NO",          "source": "employee.national_id" },
    { "header": "KRA PIN",        "source": "employee.tax_id" },
    { "header": "NSSF NO",        "source": "employee.statutory_id.nssf" },
    { "header": "GROSS PAY",      "source": "sum_taxable_amount",              "format": "fixed2" },
    { "header": "VOLUNTARY",      "source": "sum_rule.nssf_voluntary.employee","format": "fixed2" }
  ]
}
```

`xlsxWriter.writeXlsx` already emits a single-sheet workbook with header row + data rows, which is exactly what the portal accepts. No trailer, no formulas, no extra sheets.

## 5. Out of scope

- No changes to the P9 certificate work already shipped.
- No publisher UI extensions — this template does not require merged cells, print regions, or repeating headers.
- No new edge functions (deployment cap remains untouched).
- Voluntary NSSF rule authoring: column resolves to 0 today; when the KE pack later defines a `nssf_voluntary` deduction rule, the same template picks it up with no republish.
