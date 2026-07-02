-- Drop the temporary compatibility view first (depends on legacy columns).
DROP VIEW IF EXISTS public.payslips_with_aggregates CASCADE;

-- Drop deprecated country-specific columns from public.payslips.
-- Use CASCADE in case downstream views/policies/triggers reference them
-- (we intend to remove anything that does — none should remain).
ALTER TABLE public.payslips
  DROP COLUMN IF EXISTS basic_salary CASCADE,
  DROP COLUMN IF EXISTS housing_allowance CASCADE,
  DROP COLUMN IF EXISTS transport_allowance CASCADE,
  DROP COLUMN IF EXISTS overtime_pay CASCADE,
  DROP COLUMN IF EXISTS bonus CASCADE,
  DROP COLUMN IF EXISTS paye CASCADE,
  DROP COLUMN IF EXISTS nhif CASCADE,
  DROP COLUMN IF EXISTS nssf_employee CASCADE,
  DROP COLUMN IF EXISTS nssf_employer CASCADE,
  DROP COLUMN IF EXISTS housing_levy CASCADE,
  DROP COLUMN IF EXISTS personal_relief CASCADE,
  DROP COLUMN IF EXISTS insurance_relief CASCADE,
  DROP COLUMN IF EXISTS other_earnings CASCADE,
  DROP COLUMN IF EXISTS other_deductions CASCADE;

COMMENT ON TABLE public.payslips IS
  'Payslip header — universal totals + lineage only. Per-component decomposition (basic, allowances, statutory items, employer contributions, reliefs) lives in public.payslip_lines keyed by rule_code. Country-typed columns are forbidden here (Phase 4 P1.2d).';