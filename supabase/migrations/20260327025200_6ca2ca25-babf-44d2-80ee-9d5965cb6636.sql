-- Add employer_rate to housing levy rules so both employee AND employer pay 1.5%
-- Kenya's Affordable Housing Levy requires matching employer contribution
UPDATE public.payroll_statutory_rules 
SET parameters = parameters || '{"employer_rate": 0.015}'::jsonb
WHERE rule_type IN ('housing_levy', 'affordable_housing_levy')
  AND (parameters->>'employer_rate') IS NULL;