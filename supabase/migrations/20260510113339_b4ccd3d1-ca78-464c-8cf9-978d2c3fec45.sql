-- Replace partial unique index with a true unique constraint so PostgREST/PG
-- can use it for ON CONFLICT inference (Supabase upsert).
-- All existing rows already have payroll_run_id NOT NULL.
ALTER TABLE public.payroll_liabilities
  ALTER COLUMN payroll_run_id SET NOT NULL;

DROP INDEX IF EXISTS public.uq_payroll_liabilities_run_rule;

ALTER TABLE public.payroll_liabilities
  ADD CONSTRAINT uq_payroll_liabilities_run_rule
  UNIQUE (payroll_run_id, rule_code);