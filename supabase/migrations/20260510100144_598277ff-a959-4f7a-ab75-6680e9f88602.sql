-- Stage B: Lock down computation_method on rules + pack templates.
UPDATE public.payroll_statutory_rules
   SET computation_method = CASE
     WHEN parameters ? 'brackets' AND jsonb_typeof(parameters->'brackets') = 'array' THEN 'bracket_progressive'
     WHEN parameters ? 'tiers' AND jsonb_typeof(parameters->'tiers') = 'array' THEN 'tiered_brackets'
     WHEN parameters ? 'table' AND jsonb_typeof(parameters->'table') = 'array' THEN 'graduated_table'
     WHEN parameters ? 'rate' THEN 'percentage_of_gross'
     WHEN parameters ? 'amount_per_employee' THEN 'per_employee_flat'
     WHEN parameters ? 'amount' THEN 'flat_amount'
     ELSE 'flat_amount'
   END
 WHERE computation_method IS NULL
    OR lower(trim(computation_method)) IN ('', 'auto', 'unknown');

ALTER TABLE public.payroll_statutory_rules
  ALTER COLUMN computation_method DROP DEFAULT;
ALTER TABLE public.payroll_statutory_rules
  ALTER COLUMN computation_method SET NOT NULL;

ALTER TABLE public.payroll_statutory_rules
  DROP CONSTRAINT IF EXISTS payroll_statutory_rules_method_known;
ALTER TABLE public.payroll_statutory_rules
  ADD CONSTRAINT payroll_statutory_rules_method_known
  CHECK (computation_method IN (
    'bracket_progressive','tiered_brackets','percentage_of_gross',
    'graduated_table','flat_amount','per_employee_flat'
  ));

UPDATE public.localization_pack_payroll_templates
   SET computation_method = CASE
     WHEN parameters ? 'brackets' AND jsonb_typeof(parameters->'brackets') = 'array' THEN 'bracket_progressive'
     WHEN parameters ? 'tiers' AND jsonb_typeof(parameters->'tiers') = 'array' THEN 'tiered_brackets'
     WHEN parameters ? 'table' AND jsonb_typeof(parameters->'table') = 'array' THEN 'graduated_table'
     WHEN parameters ? 'rate' THEN 'percentage_of_gross'
     WHEN parameters ? 'amount_per_employee' THEN 'per_employee_flat'
     WHEN parameters ? 'amount' THEN 'flat_amount'
     ELSE 'flat_amount'
   END
 WHERE computation_method IS NULL
    OR lower(trim(computation_method)) IN ('', 'auto', 'unknown');

ALTER TABLE public.localization_pack_payroll_templates
  ALTER COLUMN computation_method DROP DEFAULT;
ALTER TABLE public.localization_pack_payroll_templates
  ALTER COLUMN computation_method SET NOT NULL;

ALTER TABLE public.localization_pack_payroll_templates
  DROP CONSTRAINT IF EXISTS localization_pack_payroll_templates_method_known;
ALTER TABLE public.localization_pack_payroll_templates
  ADD CONSTRAINT localization_pack_payroll_templates_method_known
  CHECK (computation_method IN (
    'bracket_progressive','tiered_brackets','percentage_of_gross',
    'graduated_table','flat_amount','per_employee_flat'
  ));