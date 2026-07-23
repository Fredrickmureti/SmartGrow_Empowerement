UPDATE public.localization_pack_certificate_templates
SET body = jsonb_set(
  jsonb_set(
    body,
    '{document,1,left}',
    (
      SELECT jsonb_agg(
        CASE
          WHEN kv->'value'->>'path' IN ('employer.legal_name', 'employer.registered_address', 'employer.contact')
            THEN jsonb_set(kv, '{optional}', 'true'::jsonb, true)
          ELSE kv
        END
        ORDER BY ord
      )
      FROM jsonb_array_elements(body #> '{document,1,left}') WITH ORDINALITY AS t(kv, ord)
    ),
    false
  ),
  '{document,1,right}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN kv->'value'->>'path' IN ('employee.employee_number', 'employee.department', 'employee.position')
          THEN jsonb_set(kv, '{optional}', 'true'::jsonb, true)
        ELSE kv
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(body #> '{document,1,right}') WITH ORDINALITY AS t(kv, ord)
  ),
  false
)
WHERE code = 'ANNUAL_EARNINGS_STATEMENT'
  AND pack_id IS NULL;

UPDATE public.localization_pack_certificate_templates
SET body = jsonb_set(
  body,
  '{document,5,children,4,value,path}',
  to_jsonb('ytd.employer_contributions_total'::text),
  false
)
WHERE code = 'ANNUAL_EARNINGS_STATEMENT'
  AND pack_id IS NULL;

COMMENT ON TABLE public.localization_pack_certificate_templates IS
  'Certificate and payroll report templates. Annual Earnings Statement YTD rows are required bindings; optional identity rows must be explicitly marked optional.';