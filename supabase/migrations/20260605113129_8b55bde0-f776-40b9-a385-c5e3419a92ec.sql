
ALTER TABLE public.payroll_salary_rules
  DROP COLUMN IF EXISTS accounting_debit_account_id,
  DROP COLUMN IF EXISTS accounting_credit_account_id;
