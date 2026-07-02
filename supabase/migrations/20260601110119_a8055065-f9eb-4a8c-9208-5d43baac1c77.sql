INSERT INTO public.employee_statutory_identifiers
  (employee_id, organization_id, country_code, identifier_type, identifier_value, is_active)
SELECT e.id, e.organization_id, COALESCE(e.country, 'KE'), v.identifier_type, v.identifier_value, true
FROM public.employees e
CROSS JOIN LATERAL (VALUES
  ('tax_pin', e.tax_pin),
  ('nssf',    e.nssf_number),
  ('shif',    e.shif_number),
  ('nhif',    e.nhif_number)
) AS v(identifier_type, identifier_value)
WHERE v.identifier_value IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.employee_statutory_identifiers x
    WHERE x.employee_id = e.id AND x.identifier_type = v.identifier_type
  );

ALTER TABLE public.employees
  DROP COLUMN IF EXISTS tax_pin,
  DROP COLUMN IF EXISTS nssf_number,
  DROP COLUMN IF EXISTS nhif_number,
  DROP COLUMN IF EXISTS shif_number;