-- Genericize payroll_rule_types labels (code stays same for backward compat)
UPDATE payroll_rule_types SET label = 'Income Tax Bracket', description = 'Progressive income tax bracket' WHERE code = 'paye_bracket';
UPDATE payroll_rule_types SET label = 'Health Insurance Bracket', description = 'Health insurance contribution bracket' WHERE code = 'nhif_bracket';
UPDATE payroll_rule_types SET label = 'Social Security', description = 'Social security contribution (tiered)' WHERE code = 'nssf';
UPDATE payroll_rule_types SET label = 'Housing Levy', description = 'Housing/affordable housing levy (percentage of gross)' WHERE code = 'housing_levy';
UPDATE payroll_rule_types SET label = 'Personal Relief', description = 'Monthly personal tax relief amount' WHERE code = 'personal_relief';
UPDATE payroll_rule_types SET label = 'Housing Exemption', description = 'Maximum exempt housing benefit amount' WHERE code = 'housing_exemption';

-- Add generic rule types for flat-tax and percentage-based countries
INSERT INTO payroll_rule_types (code, label, description, parameter_schema, organization_id)
SELECT 'income_tax', 'Income Tax (Flat Rate)', 'Flat-rate income tax as percentage of taxable income',
  '{"type":"object","properties":{"rate":{"type":"number","description":"Tax rate as decimal (e.g. 0.30 for 30%)"}},"required":["rate"]}'::jsonb,
  o.id
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM payroll_rule_types prt WHERE prt.code = 'income_tax' AND prt.organization_id = o.id
);

INSERT INTO payroll_rule_types (code, label, description, parameter_schema, organization_id)
SELECT 'social_security', 'Social Security (Percentage)', 'Social security contribution as percentage of gross',
  '{"type":"object","properties":{"rate":{"type":"number","description":"Contribution rate as decimal"},"ceiling":{"type":"number","description":"Maximum earnings subject to contribution"}},"required":["rate"]}'::jsonb,
  o.id
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM payroll_rule_types prt WHERE prt.code = 'social_security' AND prt.organization_id = o.id
);

INSERT INTO payroll_rule_types (code, label, description, parameter_schema, organization_id)
SELECT 'insurance_relief', 'Insurance Relief', 'Tax relief for insurance premiums',
  '{"type":"object","properties":{"max_amount":{"type":"number","description":"Maximum monthly relief amount"}},"required":["max_amount"]}'::jsonb,
  o.id
FROM organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM payroll_rule_types prt WHERE prt.code = 'insurance_relief' AND prt.organization_id = o.id
);