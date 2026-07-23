## Confirmed root cause

The Annual Earnings Statement currently has two competing monthly projection paths:

```text
Payroll facts
  -> Annual Earnings Resolver -> DTO.months / DTO.ytd
  -> generate-annual-earnings-statement -> compiler

Payroll facts
  -> generate-tax-certificate legacy matrix assembly
  -> buildMatrixRows(derived_columns, amount_field=employee_amount)
  -> overwrites payload.months before compiler
```

The failing PDF matches the second path. The resolver can produce `months.taxable` and `months.statutory_employer`, but `generate-tax-certificate` later reprojects `months` from the template's legacy `derived_columns`:

- `taxable` derives from `cat:taxable`, but taxable is a scalar, not a payslip category, so it resolves to zero.
- `statutory_employer` derives using `amount_field: employee_amount`, but employer rows carry value in `employer_amount`, so it resolves to zero.
- The compiler itself just reads `row[column.key]`; it does not execute the template derivations.

This is architectural drift, not a formatting issue.

## Implementation plan

1. **Consolidate the renderer path**
   - In `generate-tax-certificate`, when `template.code === "ANNUAL_EARNINGS_STATEMENT"`, stop running the generic v3 matrix assembly over the annual statement.
   - Keep Annual Earnings rendering bound only to `resolveAnnualEarnings()` output.
   - Preserve the generic matrix assembly for actual statutory certificate templates.

2. **Republish the base Annual Earnings template as DTO-bound presentation**
   - Update the live `localization_pack_certificate_templates` row for `ANNUAL_EARNINGS_STATEMENT`.
   - Remove `rule_codes`, `amount_field`, and `derived_columns` from the base annual statement matrix.
   - Leave columns bound directly to `months.gross`, `months.taxable`, `months.statutory_employer`, etc.
   - Keep formula-driven `derived_columns` available for country/statutory certificate templates only.

3. **Harden the DTO contract**
   - Ensure each `AnnualEarningsMonth` exposes both `month` and `month_index`, because the compiler's visible month column binds to `month`.
   - Keep YTD folding from `months[]` so monthly totals and Year-to-Date totals reconcile by construction.

4. **Add regression guards**
   - Update architecture tests so the base annual statement must not contain formula metadata or `cat:*` derived columns.
   - Add a source-level guard ensuring `generate-tax-certificate` cannot overwrite `months` for `ANNUAL_EARNINGS_STATEMENT` after resolving the annual DTO.
   - Add a compiler/resolver integration test proving the rendered monthly table contains non-zero taxable and employer contribution values from `DTO.months`.

5. **Validate the fix**
   - Run targeted tests for the resolver, annual statement architecture, and certificate compiler.
   - Deploy affected edge functions if needed, then call the annual-statement edge path with the known employee/year and verify the HTML contains the expected monthly values (`84,365.06` taxable and `7,099.94` employer contributions) and matching YTD values.

## Expected end state

```text
Payroll Engine / payslip_lines
  -> payroll_employee_monthly_breakdown
  -> resolveAnnualEarnings (single DTO writer)
  -> DTO.months and DTO.ytd
  -> Annual Earnings template (presentation only)
  -> compiler / PDF HTML
```

No annual-statement template-side calculations, no legacy overwrite of `months`, no hidden alternate path.