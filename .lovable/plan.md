## Root Cause (proven)

The payroll engine is correct. The Kenya P9/P9A **localization pack template** is mis-bound.

**Evidence:**
- `compute-payroll/index.ts:3705-3735` emits Personal Relief and Insurance Relief as first-class `payslip_lines` rows (`rule_code='personal_relief'`/`'insurance_relief'`, `category='relief'`), and PAYE (`rule_code='paye'`) is persisted **already net of relief** (`index.ts:402-404`). A trigger propagates these into `payroll_employee_ytd`.
- The certificate resolver + matrix engine (`certificateMatrix.ts`, `monthlyMatrix.ts`, `certificateSourceResolver.ts`) can expose any `rule_code` when the template declares `source_key` / `rule_codes` / `derived_columns` — proven by migration `20260712112645`, which wires exactly that.
- Migration `20260713001927` rewrote P9A as a v3 `document/matrix` body but **stripped `source_key`, `rule_codes`, and `derived_columns`** from columns `col_m` (Personal Relief), `col_n` (Insurance Relief), `col_o` (PAYE), plus `col_d` (Gross), `col_k` (Chargeable), `col_l` (Tax Charged).
- A competing correctly-wired body exists but is `schema_version: 2` (`body.blocks`), which `isV3EngineTemplate()` in `generate-tax-certificate/index.ts:79-82` rejects for the matrix path → the legacy renderer runs and has no notion of reliefs / derived PAYE.
- Result: `collectMatrixRuleCodes()` returns an incomplete set, the monthly breakdown RPC is never asked for `personal_relief`/`insurance_relief`, and those columns seed to 0. PAYE column shows whatever is bound (either 0 or the pre-relief figure), never the relief-adjusted net.

**Classification:** (A) pack mis-binding, compounded by schema-version drift. Not (B) resolver, not (C) engine persistence, not (D) generator reconstruction.

**Blast radius:**
- P9A: all six matrix columns (D, K, L, M, N, O) are unwired in the live body.
- `GH_PAYE_EMPLOYEE_ANNUAL` and `ANNUAL_EARNINGS_STATEMENT` were rewritten in the same migration with the same shape → same latent defect class.
- Any future annual statutory certificate is exposed to the same silent-zero failure mode because the matrix engine defaults missing columns to 0 instead of erroring.
- Payslips are unaffected — they read `payslip_lines` directly, bypassing the certificate resolver.

## Fix Location

**Primary — Localization pack only** (Kenya P9A template body). No engine, no resolver, no persistence changes.

**Secondary — generator hardening** (`generate-tax-certificate`): treat a v3 `matrix` node whose `collectMatrixRuleCodes()` yields an empty set as a structural error, same class as the existing `TEMPLATE_STRUCTURAL_INVALID` refusal. This converts this entire class of future authoring regressions into a loud CI/runtime failure instead of a silent zero on a filed statutory document.

## Implementation Plan

### Step 1 — Republish the KE P9A template (schema_version 3, correctly wired)

New migration that inserts a new `pack_versions` row for the Kenya pack (bumped minor version) and upserts a new `localization_pack_certificate_templates` row for code `P9A` whose `body` is a `schema_version: 3` `document` containing a `matrix` node with:

- `col_d Gross Pay` — `source_key: 'gross_pay'` derived from `sum(rule_codes where category='earning')` **or** the explicit `gross_pay` rule if the engine emits one; matches migration `20260712112645`.
- `col_k Chargeable Pay` — `derived_columns: chargeable_pay = gross_pay − sum(pre-tax deductions)` (per the existing derived-column pattern).
- `col_l Tax Charged (gross tax, pre-relief)` — `derived_columns: paye_gross = sum(paye_net, personal_relief, insurance_relief)`.
- `col_m Personal Relief` — `source_key: 'personal_relief'`.
- `col_n Insurance Relief` — `source_key: 'insurance_relief'`.
- `col_o PAYE (net)` — `source_key: 'paye'`.
- `rule_codes` at the matrix level lists the full superset so `collectMatrixRuleCodes()` returns them and the monthly breakdown RPC fetches them.
- `totals.chargeable_pay` and `totals.paye` bindings kept.

### Step 2 — Pack version + upgrade path

- Insert a new `pack_versions` row (e.g. bump patch) referencing the corrected template body.
- Rely on the existing `pack_upgrade_proposals` / pack migration machinery (`pack_migration_log`) to roll installed tenants forward — same mechanism used by the `20260713*` migrations. No bespoke upgrade code.
- Preserve `template_body_hash` invalidation so previously generated certificates remain immutable (per ADR-0060) while new generations use the fixed body.

### Step 3 — Generator hardening (defense in depth, non–Kenya-specific)

In `supabase/functions/generate-tax-certificate/index.ts`, at the matrix-detection block (~lines 621-656), after `collectMatrixRuleCodes(matrixNode)`:

- If the returned set is empty AND the matrix has data columns, throw `TEMPLATE_STRUCTURAL_INVALID` with code `MATRIX_NO_RULE_CODES` (mirroring the existing structural-refusal pattern at lines 251-311).
- If a matrix column has neither `source_key`, `rule_codes`, nor a `derived_columns` entry, refuse with `MATRIX_COLUMN_UNBOUND`.

These are country-agnostic checks on the pack contract — they don't encode Kenya rules.

### Step 4 — Architecture guard tests

- `src/test/architecture/statutory-templates-must-bind-canonical-sources.test.ts` — static walk of every `localization_pack_certificate_templates` seed/migration row with a `matrix` node; fails if any column lacks `source_key` / `rule_codes` / `derived_columns` binding, or if the matrix's `rule_codes` set is empty.
- `src/test/architecture/generate-tax-certificate-refuses-unbound-matrix.test.ts` — asserts the generator throws `MATRIX_NO_RULE_CODES` / `MATRIX_COLUMN_UNBOUND` for a stub template with an unwired matrix column. Prevents the guard from being weakened.
- pgTAP test under `supabase/tests/` that renders a KE P9A for a synthetic payslip with known `personal_relief`, `insurance_relief`, and net `paye` values and asserts M/N/O in the generated payload match the `payslip_lines` values exactly (invariant: **P9 must equal payslip, always**).

### Step 5 — ADR

New `docs/adr/00XX-statutory-templates-consume-canonical-payroll-facts.md` recording the invariant: statutory certificate templates MUST bind to `payslip_lines` rule codes via `source_key` / `rule_codes` / `derived_columns`; generators MUST NOT reconstruct payroll; unbound matrix columns are a structural error, not a silent zero. This ADR governs all future localization packs (KE, GH, and all others).

## Files touched

- `supabase/migrations/<new>_ke_p9a_template_rebind.sql` — new pack version + corrected template body.
- `supabase/functions/generate-tax-certificate/index.ts` — matrix-binding structural guards.
- `src/test/architecture/statutory-templates-must-bind-canonical-sources.test.ts` — new.
- `src/test/architecture/generate-tax-certificate-refuses-unbound-matrix.test.ts` — new.
- `supabase/tests/ke_p9a_matches_payslip_lines_test.sql` — new.
- `docs/adr/00XX-statutory-templates-consume-canonical-payroll-facts.md` — new.

## Explicitly NOT touched

- `supabase/functions/compute-payroll/**` — engine is correct.
- `payslip_lines`, `payroll_employee_ytd`, `payroll_tax_certificates` schemas — persistence is correct.
- Resolver source code (`resolver.ts`, `certificateMatrix.ts`, `monthlyMatrix.ts`) — capability exists; the defect is upstream in the pack body.
- No Kenya-specific logic added to the platform; no hardcoded Personal/Insurance Relief anywhere; the P9 template is corrected via canonical bindings, not by patching numbers into place.
