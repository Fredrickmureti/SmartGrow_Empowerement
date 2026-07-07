
ALTER TABLE public.localization_pack_payroll_templates
  DROP CONSTRAINT IF EXISTS localization_pack_payroll_templates_method_known;

ALTER TABLE public.localization_pack_payroll_templates
  ADD CONSTRAINT localization_pack_payroll_templates_method_known
  CHECK (computation_method = ANY (ARRAY[
    'bracket_progressive',
    'tiered_brackets',
    'tiered',
    'percentage_of_gross',
    'percentage',
    'graduated_table',
    'graduated',
    'flat_amount',
    'fixed',
    'per_employee_flat',
    'flat',
    'flat_rate',
    'bonus_windfall',
    'overtime_concessional'
  ]));
