## Root cause (confirmed)

`generate-tax-certificate` returns **422 TEMPLATE_STRUCTURAL_INVALID** for `ANNUAL_EARNINGS_STATEMENT`.

- `validateCanonicalSourceNode` at `supabase/functions/generate-tax-certificate/index.ts:431-434` walks every `matrix`/`grid` node and requires each data column to declare `source_key`, or appear in `node.rule_codes`, or in `derived_columns`.
- The live template row in `localization_pack_certificate_templates` for `ANNUAL_EARNINGS_STATEMENT` (just queried) has a single matrix with columns `gross / benefits / taxable / statutory_employee / statutory_employer / other_deductions / reliefs / net`, **none** carrying `source_key`, and **no** `derived_columns` — because the previous consolidation deliberately made this template DTO-bound (rows come from `resolveAnnualEarnings().months`, not from the rule-code stream).
- The validator was designed for statutory forms (P9, P60, …) where zero-filled columns would be a filed-document defect. It must not run against templates whose rows are populated from a canonical DTO overlay.

## Change

Single edit in `supabase/functions/generate-tax-certificate/index.ts`, in the block that walks matrix/grid nodes (~line 425-438):

- Skip `validateCanonicalSourceNode` when `template.code === "ANNUAL_EARNINGS_STATEMENT"`. Mirrors the identical guard already present at line 859 that skips the legacy pivot for the same template.
- Add a short comment tying both guards to ADR-0091: the annual statement is DTO-bound; its columns are populated by `resolveAnnualEarnings`, so rule-code binding assertions do not apply.

No template, migration, resolver, or compiler change. Statutory templates (P9/P60/W-2/…) keep the strict validator.

## Regression guard

Add one test in `src/test/architecture/tax-certificate-lifecycle.test.ts` (or the existing `annual-earnings-canonical-binding.test.ts`) that greps the edge-function source and asserts both the validator loop and the legacy-pivot loop exclude `ANNUAL_EARNINGS_STATEMENT` by code. Prevents someone re-enabling the validator for this template without also making its matrix rule-code-bound.

## Verification

1. `bunx vitest run src/test/architecture/tax-certificate-lifecycle.test.ts src/test/architecture/annual-earnings-canonical-binding.test.ts src/test/payroll/annual-earnings-resolver.test.ts`.
2. `supabase--curl_edge_functions` POST to `/generate-tax-certificate` with the failing employee + `ANNUAL_EARNINGS_STATEMENT` template — expect 200 with populated `ytd` and `months[]`, not 422.
