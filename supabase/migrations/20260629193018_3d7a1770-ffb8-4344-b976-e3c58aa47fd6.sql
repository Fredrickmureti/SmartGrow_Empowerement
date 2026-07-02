-- Phase 4 P1.2e: declare which salary rules accept per-run variable input.
-- Packs flip this on for rules like overtime, bonus, commission, arrears.
ALTER TABLE public.payroll_salary_rules
  ADD COLUMN IF NOT EXISTS is_variable_input boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.payroll_salary_rules.is_variable_input IS
  'When true, the rule accepts per-employee variable input on each payroll run (overtime, bonus, commission, etc.). The payroll-create UI renders a column per such rule, keyed by `code`. Country-agnostic: packs decide which rules are variable-input.';

CREATE INDEX IF NOT EXISTS idx_payroll_salary_rules_variable_input
  ON public.payroll_salary_rules (organization_id, business_id, is_variable_input)
  WHERE is_variable_input = true;