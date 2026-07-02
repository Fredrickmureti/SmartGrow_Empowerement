-- ─── Stage 2: Drop legacy Kenya-specific payroll columns ───
-- All consumers (compute-payroll, post-payroll-gl, generate-payslip-pdf,
-- generate-payroll-document, reverse-payroll, usePayroll hook,
-- PayrollRunDetailsDialog, factories) now read from payslip_lines and
-- the generic deductions_summary / contributions_summary JSONB fields.
-- Country-specific statutory data lives in payslip_lines + statutory rules
-- + the per-localization edge function (generate-localization-statutory-document).

-- Guard: ensure no view still references these columns
DO $$
DECLARE
  v_offender text;
BEGIN
  SELECT string_agg(format('%I.%I', table_schema, table_name), ', ')
    INTO v_offender
    FROM information_schema.view_column_usage
   WHERE table_schema = 'public'
     AND ((table_name = 'payslips' AND column_name IN (
            'paye','nhif','nssf_employee','nssf_employer','housing_levy',
            'personal_relief','insurance_relief','housing_allowance',
            'transport_allowance','overtime_pay','bonus','taxable_income'))
       OR (table_name = 'payroll_runs' AND column_name IN (
            'total_paye','total_nssf','total_nhif')));
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot drop legacy payroll columns — still referenced by view(s): %', v_offender;
  END IF;
END $$;

-- Drop legacy columns from payslips
ALTER TABLE public.payslips
  DROP COLUMN IF EXISTS paye,
  DROP COLUMN IF EXISTS nhif,
  DROP COLUMN IF EXISTS nssf_employee,
  DROP COLUMN IF EXISTS nssf_employer,
  DROP COLUMN IF EXISTS housing_levy,
  DROP COLUMN IF EXISTS personal_relief,
  DROP COLUMN IF EXISTS insurance_relief,
  DROP COLUMN IF EXISTS housing_allowance,
  DROP COLUMN IF EXISTS transport_allowance,
  DROP COLUMN IF EXISTS overtime_pay,
  DROP COLUMN IF EXISTS bonus,
  DROP COLUMN IF EXISTS taxable_income;

-- Drop legacy totals from payroll_runs
ALTER TABLE public.payroll_runs
  DROP COLUMN IF EXISTS total_paye,
  DROP COLUMN IF EXISTS total_nssf,
  DROP COLUMN IF EXISTS total_nhif;

-- Add total_employer_contributions if missing (engine writes it now)
ALTER TABLE public.payroll_runs
  ADD COLUMN IF NOT EXISTS total_employer_contributions numeric NOT NULL DEFAULT 0;
