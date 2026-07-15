## Root cause confirmed

- **Column N is Insurance Relief**, not Personal Relief. The current P9A template binds:
  - Column M → `personal_relief`
  - Column N → `insurance_relief`
  - Column O → net PAYE
- The user’s May payslip has PAYE source trace `personal_relief: 2400`, but there is **no separate `personal_relief` payslip_line**. Since statutory certificates consume only canonical `payslip_lines`, Column M/Personal Relief resolves to zero.
- The P9 template’s Month column is keyed as `month`, but the matrix resolver emits only `month_index`, so month labels render blank even when rows exist.
- The local payroll engine already contains the intended relief-line emission logic, but the live run proves the deployed edge function has not produced those lines for the regenerated May run.

## Implementation plan

1. **Patch the monthly matrix resolver**
   - Update `supabase/functions/_shared/monthlyMatrix.ts` so every matrix row includes both:
     - `month_index` for canonical/internal use
     - `month` for existing P9 templates that bind `{ key: "month", format: "month_short" }`
   - Update the matrix tests so this regression cannot return.

2. **Deploy the payroll/certificate edge functions**
   - Deploy `compute-payroll` so the existing relief-line emission code is actually active for new payroll runs.
   - Deploy `generate-tax-certificate` so the certificate path uses the updated shared matrix resolver.

3. **Backfill the current regenerated May payslip**
   - Insert missing `personal_relief` lines from the PAYE line’s persisted trace where `source.personal_relief > 0` and the payslip has no `personal_relief` line.
   - Insert missing `insurance_relief` lines the same way only where `source.insurance_relief > 0`.
   - This is a data repair, not a schema migration.

4. **Publish a Kenya pack upgrade version**
   - Create/record Kenya pack version `10.1.3` so tenants can accept an upgrade.
   - Changelog: fixes P9 month labels and guarantees relief columns consume canonical payslip lines.
   - Keep the template bindings unchanged except where needed; the current M/N mappings are already correct.

5. **Verify end-to-end**
   - Query `payslip_lines` for the May run and confirm `personal_relief = 2400` exists.
   - Confirm the matrix row for May would contain `month = 5`, `personal_relief = 2400`, and `insurance_relief = 0` for this employee.
   - The regenerated P9 should show May in the Month column and 2,400 under Personal Relief (Column M). Column N remains 0 unless the employee has qualifying insurance relief.