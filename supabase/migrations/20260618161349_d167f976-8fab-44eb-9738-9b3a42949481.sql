UPDATE public.payroll_statutory_rules
SET parameters = jsonb_set(
  parameters,
  '{brackets}',
  '[
    {"min": 0,      "max": 24000,  "rate": 10},
    {"min": 24001,  "max": 32333,  "rate": 25},
    {"min": 32334,  "max": 500000, "rate": 30},
    {"min": 500001, "max": 800000, "rate": 32.5},
    {"min": 800001, "max": null,   "rate": 35}
  ]'::jsonb,
  true
),
    updated_at = now()
WHERE country_code = 'KE'
  AND rule_code = 'paye'
  AND is_active = true;

UPDATE public.localization_pack_payroll_templates
SET parameters = jsonb_set(
  parameters,
  '{brackets}',
  '[
    {"min": 0,      "max": 24000,  "rate": 10},
    {"min": 24001,  "max": 32333,  "rate": 25},
    {"min": 32334,  "max": 500000, "rate": 30},
    {"min": 500001, "max": 800000, "rate": 32.5},
    {"min": 800001, "max": null,   "rate": 35}
  ]'::jsonb,
  true
)
WHERE pack_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  AND rule_type = 'income_tax';