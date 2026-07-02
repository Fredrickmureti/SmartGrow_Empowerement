
-- Seed Kenya payroll statutory rules for ALL existing organizations
-- This ensures every org gets the Kenya defaults on setup

INSERT INTO payroll_statutory_rules (organization_id, country_code, rule_type, rule_name, parameters, effective_from, sort_order, is_active)
SELECT o.id, 'KE', v.rule_type, v.rule_name, v.parameters::jsonb, '2024-01-01'::date, v.sort_order, true
FROM organizations o
CROSS JOIN (VALUES
  -- PAYE Brackets
  ('paye_bracket', 'PAYE Band 1: 10%', '{"lower": 0, "upper": 24000, "rate": 0.10}', 1),
  ('paye_bracket', 'PAYE Band 2: 25%', '{"lower": 24000, "upper": 32333, "rate": 0.25}', 2),
  ('paye_bracket', 'PAYE Band 3: 30%', '{"lower": 32333, "upper": 500000, "rate": 0.30}', 3),
  ('paye_bracket', 'PAYE Band 4: 32.5%', '{"lower": 500000, "upper": 800000, "rate": 0.325}', 4),
  ('paye_bracket', 'PAYE Band 5: 35%', '{"lower": 800000, "upper": null, "rate": 0.35}', 5),
  -- NHIF Brackets
  ('nhif_bracket', 'NHIF: Up to 5,999', '{"lower": 0, "upper": 5999, "amount": 150}', 1),
  ('nhif_bracket', 'NHIF: 6,000-7,999', '{"lower": 6000, "upper": 7999, "amount": 300}', 2),
  ('nhif_bracket', 'NHIF: 8,000-11,999', '{"lower": 8000, "upper": 11999, "amount": 400}', 3),
  ('nhif_bracket', 'NHIF: 12,000-14,999', '{"lower": 12000, "upper": 14999, "amount": 500}', 4),
  ('nhif_bracket', 'NHIF: 15,000-19,999', '{"lower": 15000, "upper": 19999, "amount": 600}', 5),
  ('nhif_bracket', 'NHIF: 20,000-24,999', '{"lower": 20000, "upper": 24999, "amount": 750}', 6),
  ('nhif_bracket', 'NHIF: 25,000-29,999', '{"lower": 25000, "upper": 29999, "amount": 850}', 7),
  ('nhif_bracket', 'NHIF: 30,000-34,999', '{"lower": 30000, "upper": 34999, "amount": 900}', 8),
  ('nhif_bracket', 'NHIF: 35,000-39,999', '{"lower": 35000, "upper": 39999, "amount": 950}', 9),
  ('nhif_bracket', 'NHIF: 40,000-44,999', '{"lower": 40000, "upper": 44999, "amount": 1000}', 10),
  ('nhif_bracket', 'NHIF: 45,000-49,999', '{"lower": 45000, "upper": 49999, "amount": 1100}', 11),
  ('nhif_bracket', 'NHIF: 50,000-59,999', '{"lower": 50000, "upper": 59999, "amount": 1200}', 12),
  ('nhif_bracket', 'NHIF: 60,000-69,999', '{"lower": 60000, "upper": 69999, "amount": 1300}', 13),
  ('nhif_bracket', 'NHIF: 70,000-79,999', '{"lower": 70000, "upper": 79999, "amount": 1400}', 14),
  ('nhif_bracket', 'NHIF: 80,000-89,999', '{"lower": 80000, "upper": 89999, "amount": 1500}', 15),
  ('nhif_bracket', 'NHIF: 90,000-99,999', '{"lower": 90000, "upper": 99999, "amount": 1600}', 16),
  ('nhif_bracket', 'NHIF: 100,000+', '{"lower": 100000, "upper": 999999999, "amount": 1700}', 17),
  -- NSSF
  ('nssf', 'NSSF Contribution', '{"tier1_limit": 7000, "tier2_limit": 36000, "rate": 0.06}', 1),
  -- Housing Levy
  ('housing_levy', 'Housing Levy', '{"rate": 0.015}', 1),
  -- Personal Relief
  ('personal_relief', 'Personal Relief', '{"amount": 2400}', 1),
  -- Housing Exemption
  ('housing_exemption', 'Housing Benefit Exemption', '{"max_amount": 15000}', 1)
) AS v(rule_type, rule_name, parameters, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM payroll_statutory_rules psr 
  WHERE psr.organization_id = o.id AND psr.country_code = 'KE'
);
