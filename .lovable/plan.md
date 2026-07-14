
## Problem

Return templates carry two column lists:

- `body.columns[]` → drives CSV/PDF and the in-app preview.
- `submission_format.columns[]` → drives the file the tax authority actually ingests (`gov_xlsx`, `gov_csv`, `gov_xml`), rendered by `supabase/functions/_shared/govFileWriter.ts`.

ADR-0062 rebound `body.columns` for the six KE templates from `sum_taxable_amount` → `sum_gross_amount`, but `submission_format.columns` was left untouched. The uploaded `NSSF_RET-…gov.xlsx` still shows GROSS PAY = 84,365.06 (taxable) instead of 94,000 (true gross). Same latent risk exists for any future pack.

## Fix

### 1. Data — rebind KE submission_format (data migration)

For every KE template whose `submission_format.columns[]` contains a header whose slug matches `gross*` (e.g. `GROSS PAY`, `Gross Emoluments`), rewrite that column's `source` from `sum_taxable_amount` → `sum_gross_amount`. Match by header/slug, not by fixed indices — publishers reorder columns.

Confirmed today for NSSF_RET; scan and fix P10 / P10A / P10D / SHIF_RET / AHL_RET too. Print a before/after diff of every touched template.

### 2. Platform guardrail — one canonical binding per column

Templates should never encode "gross" twice with different sources. Add a normalization step in the generator (or a DB check function) that, when both lists carry a column with the same key/header, requires `body.columns[k].source === submission_format.columns[k].source`. Fail loudly at generation time with `RETURN_TEMPLATE_SOURCE_MISMATCH` including the offending column.

This makes ADR-0062's "templates are lookups, never recompute" enforceable across both output surfaces.

### 3. Regression tests

- **Static guard** (`src/test/localization/ke-return-gov-file-gross-binding.test.ts`): grep all migrations for `submission_format` JSON where a `gross*` header maps to `sum_taxable_amount`. Fail on any hit outside the allow-list of pre-fix historical migrations.
- **Runtime guard** (`src/test/localization/return-gov-file-column-parity.test.ts`): for a fixture template with divergent `body` vs `submission_format` gross bindings, `generate-statutory-return` must return the new `RETURN_TEMPLATE_SOURCE_MISMATCH` error.
- **XLSX contract test**: feed the KE_RETURN_PREVIEW_PAYLOAD through `renderGovFile` with the fixed NSSF_RET descriptor; assert the GROSS PAY cell equals `sums.gross`, not `sums.taxable`.

### 4. ADR update

Amend `docs/adr/0062-canonical-payroll-values.md` with a "Submission format parity" section documenting that every declarative surface (`body.columns`, `submission_format.columns`, and any future portal descriptor) must share the same canonical source per column, and pointing at the new guardrail.

## Files touched

- **Migration (new)** — rebind six KE templates' `submission_format.columns[].source` where header is gross-like.
- `supabase/functions/generate-statutory-return/index.ts` — add mismatch check between `body.columns` and `submission_format.columns` sharing a key/header.
- `docs/adr/0062-canonical-payroll-values.md` — amendment.
- `src/test/localization/ke-return-gov-file-gross-binding.test.ts` (new).
- `src/test/localization/return-gov-file-column-parity.test.ts` (new).

## Out of scope

- Retro-editing the already-uploaded/filed xlsx artifact. Users regenerate returns after the migration lands; storage cleanup is a separate task if requested.
- Capped pensionable-earnings source (`sum_rule_base.<code>`) — still tracked as the ADR-0062 follow-up.
