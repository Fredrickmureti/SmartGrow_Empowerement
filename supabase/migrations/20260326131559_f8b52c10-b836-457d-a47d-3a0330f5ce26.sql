
-- Add SHIF rule type
INSERT INTO public.payroll_rule_types (organization_id, code, label, description, parameter_schema, is_bracket, is_system, sort_order)
SELECT 
  org.id,
  'shif',
  'SHIF (Social Health Insurance)',
  'Social Health Insurance Fund - percentage of gross income (replaced NHIF Oct 2024)',
  '[{"key":"rate","label":"Contribution Rate (decimal)","type":"number","placeholder":"e.g. 0.0275 for 2.75%","step":"0.0001"},{"key":"employee_rate","label":"Employee Rate (decimal, optional)","type":"number","placeholder":"Same as rate if blank","step":"0.0001","optional":true},{"key":"employer_rate","label":"Employer Rate (decimal, optional)","type":"number","placeholder":"e.g. 0.0275","step":"0.0001","optional":true},{"key":"cap","label":"Monthly Cap (optional)","type":"number","placeholder":"Leave blank for no cap","optional":true}]'::jsonb,
  false,
  true,
  2
FROM public.organizations org
WHERE NOT EXISTS (
  SELECT 1 FROM public.payroll_rule_types prt 
  WHERE prt.organization_id = org.id AND prt.code = 'shif'
);
