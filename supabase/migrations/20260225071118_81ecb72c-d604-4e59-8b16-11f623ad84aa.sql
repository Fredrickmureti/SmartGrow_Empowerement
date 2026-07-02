
-- Add generic JSONB columns for payroll_runs if they don't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_runs' AND column_name='deductions_summary') THEN
    ALTER TABLE public.payroll_runs ADD COLUMN deductions_summary jsonb DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_runs' AND column_name='contributions_summary') THEN
    ALTER TABLE public.payroll_runs ADD COLUMN contributions_summary jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Add generic JSONB columns for payslips if they don't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payslips' AND column_name='deductions_detail') THEN
    ALTER TABLE public.payslips ADD COLUMN deductions_detail jsonb DEFAULT '{}'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payslips' AND column_name='contributions_detail') THEN
    ALTER TABLE public.payslips ADD COLUMN contributions_detail jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Create unique constraint to prevent duplicate payroll periods per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_unique_period 
  ON public.payroll_runs (organization_id, business_id, pay_period_start, pay_period_end) 
  WHERE status != 'deleted';
