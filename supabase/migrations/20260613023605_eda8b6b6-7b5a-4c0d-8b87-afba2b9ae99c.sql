
-- Seed placeholder employer statutory identifiers for Apex Traders.
-- These are clearly flagged as placeholders. The Payroll Setup screen
-- surfaces a banner asking the admin to replace them with real values.
INSERT INTO public.organization_statutory_identifiers
  (organization_id, business_id, country_code, identifier_type, identifier_value, is_active)
VALUES
  ('bba6bdfc-852d-4d7f-b9b4-c4102c5a12c0', 'fadf5c29-5b12-4039-9e4d-f5b65811385f', 'KE', 'tax_pin',      'P000000000X', true),
  ('bba6bdfc-852d-4d7f-b9b4-c4102c5a12c0', 'fadf5c29-5b12-4039-9e4d-f5b65811385f', 'KE', 'nssf_number',  'EMPLOYER-NSSF-PENDING', true),
  ('bba6bdfc-852d-4d7f-b9b4-c4102c5a12c0', 'fadf5c29-5b12-4039-9e4d-f5b65811385f', 'KE', 'shif_number',  'EMPLOYER-SHIF-PENDING', true),
  ('bba6bdfc-852d-4d7f-b9b4-c4102c5a12c0', 'fadf5c29-5b12-4039-9e4d-f5b65811385f', 'KE', 'housing_levy', 'EMPLOYER-AHL-PENDING',  true)
ON CONFLICT DO NOTHING;
