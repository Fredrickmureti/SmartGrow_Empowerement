## Problem

The published KE P9A template in the database (`localization_pack_certificate_templates`) still uses the **legacy v3 layout**:
- `heading` with fiscal year
- `identity_strip` with two labeled column blocks titled `Employer` / `Employee` (Name/PIN/Tax Office/Address on the left, Main Name/Other Names/PIN/Employee No. on the right)

This does not match the KRA Appendix 2A form the user attached (`Original-p9-Template.pdf`), which shows:

```text
APPENDIX 2A            KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT
                       TAX DEDUCTION CARD YEAR 20 .........

Employers Name  ....................................   Employer's PIN  ..............
Employee's Main Name  ..............................   Employee's PIN  ..............
Employee's Other Names  ...................................................................
```

The **canonical source template** at `src/features/localization/lib/engine/templates/keP9.ts` **already expresses this exact layout** using v4 primitives (`page_master` with 3-column header + inline `field_row`/`label_fill` identity rows), but the DB body was hand-published from an older v3 spec and was never re-synced to the canonical source. So the fix is a data refresh, not a schema change.

The publisher editor (`CertificateV3Editor.tsx`) already supports all needed v4 primitives — `label_fill`, `field_row`, `columns`, `page_master`, `grid` — confirmed by inspecting the node type registry and inspectors. No editor code changes required.

## Fix (pack-only, data-only)

### 1. DB migration — republish KE P9A body from canonical source

Single `supabase--migration` that:

1. Replaces `body` on the KE P9A `localization_pack_certificate_templates` row with the canonical `KE_P9_V3_TEMPLATE` (`schema_version: 4`) — the exact structure from `keP9.ts`:
   - `paper_format`: A4 landscape, statutory margins
   - `page_master.header`: 3-column band → left `APPENDIX 2A`, centre `KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT` + `TAX DEDUCTION CARD` + `YEAR {fiscal_year}`, right `ISO 9001:2015 CERTIFIED`
   - `page_master.footer`: Serial + Generated line
   - `document[0..2]`: three inline `field_row` blocks → `Employer's Name … Employer's PIN`, `Employee's Main Name … Employee's PIN`, `Employee's Other Names …`, all dotted-rule `label_fill`
   - `document[3]`: `spacer`
   - `document[4]`: `grid` — the 4-row header stack + 17 columns + `TOTAL` footer, with the previously fixed `derived_columns` (`col_d`/`col_e1`/`col_e3`/`col_j`/`col_k`/`col_l` computed from real `source_key` inputs, no `col_*` alias mismatches)
   - `document[5..7]`: end-of-year "To be completed by Employer" caption + inline totals fill-in + IMPORTANT/Attach two-column notice with nested numbered lists
   - `theme`: statutory form aesthetic (Times body, black rules, no zebra, no grey shading)

2. Publishes a new `pack_versions` row for Kenya: `version = '10.1.5'`, `status = 'published'`, with changelog:

   > **10.1.5** — Rebuild P9A header/identity band to match KRA Appendix 2A: `APPENDIX 2A` left-aligned band, centred `KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT / TAX DEDUCTION CARD / YEAR 20 …`, and inline dotted `Employers Name … Employer's PIN / Employee's Main Name … Employee's PIN / Employee's Other Names …` fill-in lines. No calculation changes.

3. Leaves the two-column `EMPLOYER` / `EMPLOYEE` `identity_strip` behind — replaced, not appended.

### 2. Editor sanity check (no changes expected)

Confirm the editor already exposes `label_fill`, `field_row`, `columns`, `page_master` node inspectors (verified in `CertificateV3Editor.tsx` — nothing to add).

### 3. Verification

After the migration:
- Query the DB and pretty-print `body->'document'->0..2` + `body->'page_master'->'header'` to confirm the shape.
- Compile the DB body via the engine and diff its `html` against a compile of the source `KE_P9_V3_TEMPLATE` — they should be byte-identical (both drive off the same AST).
- Regenerate a P9 for the May 2026 payslip and eyeball the header vs the KRA original.

## Out of scope

- No changes to the payroll engine, resolver, monthly matrix, compiler, or column bindings — the 10.1.4 fix stands.
- No changes to `keP9.ts` — it is already the canonical source; we are re-syncing the DB *to* it.
- No editor code changes — the primitives already ship.
- No new architecture tests — existing "no country tokens" and "matrix derived args must resolve" tests still guard this template.

## Technical detail

The migration is a single UPDATE on the KE P9A row using `jsonb_build_object` (or a `body = $$…$$::jsonb` literal) to install the full v4 body verbatim from `keP9.ts`, followed by an INSERT into `pack_versions` with `country_code = 'KE'`, `version = '10.1.5'`, `status = 'published'`, and `changelog`. Existing tenants pick up 10.1.5 through the standard pack-sync flow.
