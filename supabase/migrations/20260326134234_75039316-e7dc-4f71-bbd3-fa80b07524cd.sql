-- Phase 1: Add computation_method to payroll_statutory_rules
-- This replaces the fragile heuristic dispatch in compute-payroll
ALTER TABLE public.payroll_statutory_rules
ADD COLUMN IF NOT EXISTS computation_method text NOT NULL DEFAULT 'auto';

COMMENT ON COLUMN public.payroll_statutory_rules.computation_method IS 
'Explicit computation method: bracket_progressive, bracket_flat, tiered, percentage, fixed. "auto" for legacy heuristic dispatch.';

-- Backfill existing rules based on current heuristic patterns
-- Rules with rate + lower boundary + multiple rows = bracket_progressive (PAYE)
-- Rules with amount + lower boundary = bracket_flat (NHIF)
-- Rules with tier1_limit = tiered (NSSF)
-- Rules with rate only = percentage (Housing Levy)
-- Rules with amount only = fixed (Personal Relief)
UPDATE public.payroll_statutory_rules
SET computation_method = CASE
  WHEN rule_type = 'personal_relief' THEN 'fixed'
  WHEN rule_type = 'housing_exemption' THEN 'fixed'
  WHEN rule_type = 'insurance_relief' THEN 'percentage'
  WHEN (parameters->>'tier1_limit') IS NOT NULL THEN 'tiered'
  WHEN (parameters->>'rate') IS NOT NULL AND (parameters->>'lower') IS NOT NULL THEN 'bracket_progressive'
  WHEN (parameters->>'amount') IS NOT NULL AND (parameters->>'lower') IS NOT NULL THEN 'bracket_flat'
  WHEN (parameters->>'rate') IS NOT NULL THEN 'percentage'
  WHEN (parameters->>'amount') IS NOT NULL THEN 'fixed'
  ELSE 'auto'
END
WHERE computation_method = 'auto';

-- Add created_by to payroll_runs for maker-checker enforcement
ALTER TABLE public.payroll_runs
ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id);

-- Add leave_deduction columns to payslips for tracking
ALTER TABLE public.payslips
ADD COLUMN IF NOT EXISTS unpaid_leave_days numeric DEFAULT 0,
ADD COLUMN IF NOT EXISTS leave_deduction numeric DEFAULT 0;