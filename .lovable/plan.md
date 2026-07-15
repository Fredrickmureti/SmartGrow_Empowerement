
## Investigation continuation — completing the last verification

The previous agent's plan file, the ADR-0061 companion migration, the
`monthlyMatrix` `month` alias fix, the engine's relief-line persistence,
and KE pack 10.1.3 are all already in place. I picked up the "last
column-binding verification" they deferred and finished it against the
live database. That check is what determines whether we ship more code
or not.

## End-to-end trace (verified against live data)

Target: employee `5449cd48…`, May 2026 payslip `329ba45d…` (status
`approved`, run `approved_at` set).

1. Engine → `payslip_lines` (verified via `supabase--read_query`):
   - `basic` employee_amount = **80,000**
   - `nssf` employee_amount = **5,639.94**
   - `shif` = **2,585**, `housing_levy` = **1,410**
   - `personal_relief` (category `relief`) employee_amount = **2,400** ✓
   - `paye` (category `statutory_employee`) employee_amount = **17,692.32**
     with `source.gross_tax = 20,092.32`, `source.personal_relief = 2,400`,
     `source.final_tax = 17,692.32`. **PAYE is already persisted net of
     relief** as the canonical fact.
   - `insurance_relief` correctly absent (employee has no insurance).

2. RPC `payroll_employee_monthly_breakdown(2026, employee, [basic,
   housing_allowance, transport_allowance, non_cash_benefits,
   housing_benefit, nssf, housing_levy, shif, prmf,
   mortgage_interest_relief_base, paye, personal_relief,
   insurance_relief])` returns for month 5:
   - basic 80,000 · nssf 5,639.94 · shif 2,585 · housing_levy 1,410 ·
     **paye 17,692.32** · **personal_relief 2,400** ·
     insurance_relief 0.
   The canonical pipeline is intact from engine → persistence → RPC.

3. Matrix pivot (`monthlyMatrix.ts`): month row = 5 with all the above
   rule-code keys populated. `month` alias fix confirmed present.

4. Column aliasing (`certificateMatrix.buildMatrixRows`): each column
   with `source_key` copies `row[source_key] → row[column.key]`. After
   this pass month-5 has:
   - `basic_salary = 80,000` · `pension_contribution_actual = 5,639.94`
   - `ahl_employee = 1,410` · `shif_employee = 2,585`
   - `personal_relief = 2,400` · `insurance_relief = 0`
   - `paye_net = 17,692.32`

   → **Cols A, E2, F, G, M, N, O are correctly bound and will render
   the right numbers.**

5. Derived columns (KE pack 10.1.3 template body, freshly read from the
   DB). Current `derived_columns` in the published template:

   ```
   col_d  = sum(col_a, housing_allowance, transport_allowance, col_b, col_c)
   col_e1 = pct(col_a, 0.30)
   col_e3 = min(col_e1, col_e2, 30000)
   col_j  = sum(col_e3, col_f, col_g, col_h, col_i)
   col_k  = sub(col_d, col_j)
   col_l  = sum(col_o, col_m, col_n)
   ```

   None of `col_a … col_o` exist as row keys. The actual column keys
   after aliasing are `basic_salary`, `non_cash_benefits`,
   `housing_benefit`, `gross_pay`, `pension_30pct_of_basic`,
   `pension_contribution_actual`, `pension_statutory_cap`,
   `ahl_employee`, `shif_employee`, `prmf_employee`,
   `mortgage_interest_relief_base`, `total_relief_deductions`,
   `chargeable_pay`, `paye_gross`, `personal_relief`,
   `insurance_relief`, `paye_net`.

   `argValue()` in `monthlyMatrix.ts` treats missing keys as 0 →
   `col_d/col_e1/col_e3/col_j/col_k/col_l` all evaluate to 0, but are
   stored under `row.col_d`, `row.col_l`, …, which no column binds to.

   → **Cols D (Gross), E1, E3, J (Total Deductions), K (Chargeable
   Pay), L (Tax Charged) render as 0.**

The user's original complaint conflates "Personal Relief 0 / Insurance
Relief 0 / PAYE = tax-before-relief" — that description matches the
state **before** the previous agent's engine+alias fixes. Against the
current 10.1.3 template + fixed engine, M/N/O now render, but D/E1/E3/
J/K/L still render as 0. The P9 is still wrong; the wrong columns are
just different ones. Root cause is still template mis-binding, not
platform.

## Root cause

Category **A + a latent architecture gap**:

- **A (pack):** KE P9A `derived_columns` reference invented shorthand
  keys (`col_a…col_o`) that were never emitted by the pivot/aliaser.
  Six of the 17 P9 columns silently zero out.
- **Architecture gap:** ADR-0061 already fails builds on unbound matrix
  data columns, but does **not** validate that every string arg inside
  `derived_columns` resolves to a real column key, an earlier derived
  key, or a raw `rule_code` listed in `matrix.rule_codes`. Any pack can
  reintroduce this class of defect.

Engine, persistence, `payroll_employee_monthly_breakdown`,
`certificateSourceResolver`, `certificateMatrix`, `monthlyMatrix`, and
the compiler are all correct. No platform code changes required for
the KE fix itself.

## Blast radius

- Pack-only fix: KE P9A template body (v3 `matrix` node — swap the
  invented `col_*` keys for the real column keys the pack already
  declares). Bump `localization_packs.version` 10.1.3 → 10.1.4.
- Existing tenants get the new template via the standard
  `pack_upgrade_proposals` flow (no data migration; certificate is
  regenerated on demand).
- Static test addition catches this class of defect for every current
  and future pack (KE P9A/P9B, GH_PAYE annual, generic annual earnings
  statement, and anything shipped later).
- Ghana / generic templates: they use no `derived_columns` today, so
  no new failures — but the new test guards them going forward.

## Solution

1. **Fix KE P9A template body (data-only migration).** Replace the
   `derived_columns` block with correct references. New derived block:

   ```
   gross_pay              = sum(basic_salary, non_cash_benefits, housing_benefit)
   pension_30pct_of_basic = pct(basic_salary, 0.30)
   pension_statutory_cap  = min(pension_30pct_of_basic,
                                pension_contribution_actual, 30000)
   total_relief_deductions= sum(pension_statutory_cap, ahl_employee,
                                shif_employee, prmf_employee,
                                mortgage_interest_relief_base)
   chargeable_pay         = sub(gross_pay, total_relief_deductions)
   paye_gross             = sum(paye_net, personal_relief, insurance_relief)
   ```

   Keys now match the columns' `key` fields, so cols D/E1/E3/J/K/L
   render. Cols M/N/O already work via `source_key`. Formula
   `paye_gross = paye_net + personal_relief + insurance_relief`
   reconstructs Col L from canonical facts — no independent recomputation
   of tax, matching ADR-0061.

2. **Bump pack version to 10.1.4** with a changelog explaining
   "corrects P9A derived-column key references so Gross Pay, Pension
   caps, Total Deductions, Chargeable Pay and Tax Charged render".
   Register a `pack_upgrade_proposals` row so tenants on 10.1.3 accept
   the upgrade normally.

3. **Add architecture test**
   `src/test/architecture/matrix-derived-columns-must-resolve.test.ts`.
   For every v3 certificate template body in the migration set + every
   row in `localization_pack_certificate_template_overrides` shipped in
   fixtures, walk each `matrix` node and assert that every string arg
   in every `derived_columns[i].args` is one of:
   - another column `key` in the same matrix, or
   - an earlier `derived_columns[j].key` (j < i), or
   - a rule_code present in `matrix.rule_codes`.
   Fail CI with a clear message listing offending pack+template+column.

4. **Runtime defense-in-depth in `generate-tax-certificate`.** Extend
   the existing `TEMPLATE_STRUCTURAL_INVALID` refusal (already covers
   `MATRIX_NO_RULE_CODES` / `MATRIX_COLUMN_UNBOUND`) with a new reason
   code `MATRIX_DERIVED_ARG_UNRESOLVED` that runs the same check the
   test does before pivoting. Catches override templates authored
   outside the migration set.

5. **Regenerate the affected May payslip's P9A** and confirm:
   - Month column: "May"
   - A = 80,000 · D = 80,000 · E2 = 5,639.94 ·
     E1 = 24,000 · E3 = 5,639.94 · F = 1,410 · G = 2,585 ·
     J = 9,634.94 · K = 70,365.06 · L = 20,092.32 · M = 2,400 ·
     N = 0 · O = 17,692.32
   - `L = O + M + N` reconciles.

No changes to `compute-payroll`, `payslip_lines`,
`payroll_employee_ytd*`, resolver, matrix engine, or the compiler.

## Where the fix lives

| Layer | Change |
|---|---|
| Payroll engine | none |
| Persistence | none |
| Resolver | none |
| Matrix / compile | none (behaviour correct) |
| **Localization pack (KE P9A body)** | **fix `derived_columns` keys, bump to 10.1.4** |
| **Platform architecture test** | **new test: derived-column args must resolve** |
| **Runtime generator** | small addition — refuse unresolvable derived args |

## Implementation order

1. Migration: update KE pack `localization_pack_certificate_templates`
   row for P9A with corrected `derived_columns`, bump pack `version` to
   `10.1.4`, insert `pack_versions` + `pack_upgrade_proposals` rows.
2. Add `MATRIX_DERIVED_ARG_UNRESOLVED` check in
   `supabase/functions/_shared/certificateMatrix.ts` (or a new
   `certificateMatrixValidation.ts`) and wire into
   `generate-tax-certificate`.
3. Add architecture test walking every migration-shipped template body.
4. Deploy `generate-tax-certificate`; regenerate May P9A; verify all
   17 columns; confirm `L = O + M + N`.
5. Update ADR-0061 with the new invariant and reason code.
