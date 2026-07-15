# ADR-0061 — Statutory certificate templates must consume canonical payroll facts

Status: Accepted
Date: 2026-07-15
Supersedes: none
Related: ADR-0060 (single writer for YTD rollup)

## Context

The Kenya P9A tax deduction card was shipping to tenants with `Personal
Relief = 0`, `Insurance Relief = 0`, and `PAYE = tax-charged-before-
relief` for the monthly matrix — while the payslip for the same
employee/period showed the correct, relief-adjusted numbers.

Investigation established:

- The payroll engine (`compute-payroll`) correctly persists Personal
  Relief and Insurance Relief as first-class `payslip_lines` rows
  (`rule_code = personal_relief` / `insurance_relief`,
  `category = relief`) and persists PAYE (`rule_code = paye`) already
  net of relief. The engine, `payslip_lines`, `payroll_employee_ytd`,
  and the rollup/monthly-breakdown RPCs are all correct.
- The certificate resolver and matrix engine
  (`certificateMatrix.ts`, `monthlyMatrix.ts`, `certificateSourceResolver.ts`)
  are country-agnostic and capable of exposing any `rule_code` — given
  the template declares `source_key` / `rule_codes` / `derived_columns`.
- The KE P9A template body was republished (migration
  `20260713001927`) with a v3 `matrix` node whose data columns carried
  **no** `source_key`, no matrix-level `rule_codes`, and no
  `derived_columns`. `collectMatrixRuleCodes()` therefore returned an
  empty set, `payroll_employee_monthly_breakdown` was never asked for
  the relief rule codes, and the affected columns silently seeded to 0
  on the generated PDF.

The defect class is **template mis-binding**, not an engine bug. The
same mis-binding pattern exists latently on other certificates
rewritten in the same migration (Ghana `GH_PAYE_EMPLOYEE_ANNUAL`, the
generic `ANNUAL_EARNINGS_STATEMENT`) and can recur on any future pack.

## Decision

We commit to the following invariants across every localization pack
and every statutory certificate published from the platform:

1. **`payslip_lines` is the sole source of truth for payroll facts.**
   Certificate generation MUST NOT reconstruct tax, relief, or any
   other payroll figure. Every value on a filed statutory document is
   sourced from a `payslip_lines` row (via
   `payroll_employee_ytd_rollup` / `payroll_employee_monthly_breakdown`)
   or from a pack-authored `derived_columns` expression evaluated over
   those rows.

2. **Every matrix data column MUST be canonically bound.**
   A v3 `matrix` node's data columns (any column that is not the
   month axis) MUST declare either:
     - a `source_key` naming a canonical `rule_code`, or
     - membership as a `derived_columns` entry keyed to the column's `key`.
   The matrix MUST additionally list the full superset of consumed raw
   rule codes at `matrix.rule_codes` so
   `payroll_employee_monthly_breakdown` receives them.

3. **Unbound matrix columns are a structural error, not a silent zero.**
   `generate-tax-certificate` refuses templates whose matrices resolve
   to an empty rule-code set or contain unbound data columns with
   `TEMPLATE_STRUCTURAL_INVALID` (reason codes `MATRIX_NO_RULE_CODES`
   and `MATRIX_COLUMN_UNBOUND`). This converts template-authoring
   regressions into a loud, caught failure.

4. **No country-specific logic in the platform.**
   Legal math (relief formulas, statutory caps, tax brackets) lives
   inside the pack — as PAYE rule parameters (engine side) and as
   `derived_columns` expressions (template side). The generator, the
   resolver, and the matrix pivot code remain country-agnostic.

## Consequences

- KE P9A template body republished with correct bindings (this ADR's
  companion migration).
- Static architecture test
  (`src/test/architecture/statutory-templates-must-bind-canonical-sources.test.ts`)
  walks every v3 certificate template body in the migration set and
  fails CI on any unbound matrix data column, guarding all packs
  including future ones.
- Runtime structural refusal in `generate-tax-certificate` provides
  defense in depth for override templates authored outside the migration
  set (`localization_pack_certificate_template_overrides`).
- Payslips are unaffected — they read `payslip_lines` directly and never
  went through the certificate matrix layer.

## Non-goals

- No changes to the payroll engine (`compute-payroll`), the
  persistence layer (`payslip_lines`, `payroll_employee_ytd`), the
  resolver, or the matrix/pivot code. The capability to render the
  correct P9A already existed — the pack simply failed to use it.
- No hardcoded Personal Relief or Insurance Relief anywhere in the
  platform.
