Findings from the current tenant data:

- April 2026 payroll run exists and is approved + GL posted:
  - `payroll_runs.status = posted`
  - `approved_at` is present
  - `posted_at` is present
  - `posting_status = posted`
- The selected P10 template is correctly configured as accrual-basis for readiness:
  - effective `payslip_status` filter is `approved | validated | paid`
- The actual blocking row is the payslip:
  - one April payslip exists
  - `payslips.status = pending`
  - therefore it fails both the UI preflight and the edge function gate

Answer to your core question:

Yes — for P10, an approved payroll run should be enough to generate the return document. The user should not have to pay employees or remittance liabilities first. The current failure is not because P10 still requires payment; it is because payroll approval updated `payroll_runs`, but did not promote the computed payslip from `pending` to an approval-final status.

This is a lifecycle consistency bug between run approval and payslip approval, not a return-generation bug.

Plan:

1. Fix payroll approval lifecycle at the source
   - Update the `approve_payroll_run` database function so that when a payroll run is approved, every payslip on that run in `pending`/draft-like status is atomically promoted to `approved`.
   - Keep payroll approval as the legal immutability event for accrual-basis statutory returns.
   - Do not mark payslips `paid`; payment remains a separate cash workflow.

2. Repair the current tenant's April 2026 approved run safely
   - Backfill payslips for already-approved payroll runs where:
     - run has `approved_at IS NOT NULL`
     - payslip is still `pending`
   - Promote those payslips to `approved`, not `paid`.
   - This specifically makes April 2026 P10 eligible without pretending cash payment happened.

3. Correct readiness language
   - Change the UI warning copy so accrual-basis templates do not tell users to go to Payment Batches when the required statuses include `approved`.
   - For P10/P10A/P10D it should say the run is approved but the payslip lifecycle is inconsistent and needs approval finalization.
   - Keep payment wording only for cash-basis templates whose required status is only `paid`.

4. Add regression coverage
   - Add an architecture/unit test proving P10 readiness accepts approved payslips.
   - Add a database/RPC signature expectation test or SQL fixture check documenting that payroll approval must promote pending payslips to approved.

5. Validate against the real April 2026 path
   - Re-query the tenant after the change:
     - April run remains posted/approved.
     - April payslip becomes `approved`.
     - P10 effective filter remains `approved | validated | paid`.
   - Verify the Generate button should be enabled for April 2026 P10.
   - The edge function should no longer return `NO_ELIGIBLE_PAYSLIPS` for this P10 case.