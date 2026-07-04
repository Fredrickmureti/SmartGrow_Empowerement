
ALTER TABLE public.payslip_lines
  ADD COLUMN IF NOT EXISTS accounting_tag text;

CREATE INDEX IF NOT EXISTS payslip_lines_run_tag_idx
  ON public.payslip_lines (payroll_run_id, accounting_tag)
  WHERE accounting_tag IS NOT NULL;

COMMENT ON COLUMN public.payslip_lines.accounting_tag IS
  'Optional bucket label sourced from payroll_work_entry_types.accounting_tag / payroll_salary_rules.accounting_tag. Used by post-payroll-gl to split salary_expense into per-tag debit lines (mapping key salary_expense_<TAG>). NULL means "post to the generic salary_expense account" — the default legacy behaviour.';
