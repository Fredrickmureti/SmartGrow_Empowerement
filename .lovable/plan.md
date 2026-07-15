## Plan

1. **Fix the actual template/runtime mismatch for Certificate of Service**
   - Remove the fake `Positions Held` payroll matrix from `CERT_OF_SERVICE`.
   - Update `generate-tax-certificate` so text-only service certificates are not forced through payroll matrix/YTD validation.
   - Keep Certificate of Service rendered through the same certificate HTML engine, but source its facts from employee/employer/service fields instead of payroll monthly rows.

2. **Harden Annual Earnings Statement at the source**
   - Keep the generic `ANNUAL_EARNINGS_STATEMENT` template bound through `derived_columns` using canonical `cat:*` payroll category aggregates.
   - Ensure the edge function’s deployed logic treats `cat:*` matrices as valid and fetches all monthly payroll rows for category rollups.
   - Remove any stale/invalid category assumptions such as `cat:benefit` from the live template body.

3. **Patch all sibling templates that can hit the same 422**
   - Audit current certificate templates with matrices/grids.
   - Any payroll certificate matrix must have `source_key`, `rule_codes`, or `derived_columns`.
   - Any non-payroll certificate must not use a fake payroll matrix just to satisfy validation.

4. **Bump pack versions for upgrade flow**
   - Bump the Kenya Fiscal Localization pack above the current `10.1.6` after republishing `CERT_OF_SERVICE`.
   - If Ghana/other PAYE annual templates need the same binding correction, bump those pack versions too and create upgrade proposals so tenants can upgrade cleanly.

5. **Add regression guards**
   - Add/extend tests proving:
     - `CERT_OF_SERVICE` can be structurally valid without a payroll matrix.
     - `ANNUAL_EARNINGS_STATEMENT` has no unbound matrix columns.
     - `cat:*` derived-column args are valid runtime symbols.
     - the generator does not require YTD payroll rows for Certificate of Service.

6. **Deploy and validate the edge function**
   - Deploy `generate-tax-certificate` after code changes.
   - Use edge-function logs and targeted tests to verify the 422 is gone for Annual Earnings Statement and Certificate of Service, rather than merely hiding the error.

## Technical diagnosis

- The live `CERT_OF_SERVICE` template currently contains a `matrix` with text columns: `from`, `to`, `position`, `department`.
- The generator validates every matrix/grid as if it must bind to payroll facts; those text columns have no `source_key`, no `rule_codes`, and no `derived_columns`, so the function correctly returns `422 TEMPLATE_STRUCTURAL_INVALID`.
- That means the root issue is not the browser hook at `useTaxCertificates.ts:260`; it is a server-side contract mismatch between certificate type and template validation.
- Annual Earnings is a separate but related matrix-binding path; the live DB now has canonical category bindings, so the remaining work is to make sure the deployed edge function and all sibling templates follow that contract consistently.