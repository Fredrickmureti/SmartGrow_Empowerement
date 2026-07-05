-- Payroll audit 2026-07-05 closeout — pack deductibility contract integrity.
--
-- Enforces that every rule_code referenced by an income_tax rule's
-- `parameters.pre_tax_deductions[]` array either:
--   (a) exists as an active sibling statutory rule in the same org that
--       carries `parameters.reduces_taxable_income = true`, OR
--   (b) is an employee-input token registered in the engine's
--       EMPLOYEE_INPUT_REGISTRY (pension_contribution, mortgage_interest,
--       post_retirement_medical, insurance_premium, ahr_contribution).
--
-- Any other case means the pack references a code that the engine cannot
-- resolve, i.e. a silent no-op that under-taxes or over-taxes the employee.
BEGIN;

-- Load the pgTAP extension if available; fall back to plain asserts otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgtap') THEN
    PERFORM 1;
  END IF;
END $$;

-- Known engine-side employee-input tokens. Kept in sync with
-- EMPLOYEE_INPUT_REGISTRY in supabase/functions/compute-payroll/index.ts.
-- Adding a new pack input requires updating both this list and the registry.
WITH engine_input_tokens(code) AS (
  VALUES
    ('insurance_premium'),
    ('ahr_contribution'),
    ('mortgage_interest'),
    ('pension_contribution'),
    ('post_retirement_medical')
),
declared AS (
  SELECT
    it.organization_id,
    it.country_code,
    lower(x.code) AS pre_tax_code
  FROM public.payroll_statutory_rules it
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(it.parameters->'pre_tax_deductions', '[]'::jsonb)
  ) AS x(code)
  WHERE it.rule_type = 'income_tax'
    AND it.is_active = true
),
resolved AS (
  SELECT d.*,
    EXISTS (
      SELECT 1
      FROM public.payroll_statutory_rules s
      WHERE s.is_active = true
        AND s.organization_id IS NOT DISTINCT FROM d.organization_id
        AND s.country_code = d.country_code
        AND lower(s.rule_code) = d.pre_tax_code
        AND COALESCE((s.parameters->>'reduces_taxable_income')::boolean, false) = true
    ) AS matches_sibling,
    EXISTS (
      SELECT 1 FROM engine_input_tokens t WHERE t.code = d.pre_tax_code
    ) AS matches_engine_input
  FROM declared d
),
orphans AS (
  SELECT * FROM resolved
  WHERE NOT matches_sibling AND NOT matches_engine_input
)
SELECT
  CASE
    WHEN (SELECT count(*) FROM orphans) = 0
      THEN 'OK — every pre_tax_deductions[] entry resolves'
    ELSE 'FAIL — orphan pre_tax_deductions codes: ' ||
         (SELECT string_agg(
            format('%s (country=%s, org=%s)',
              pre_tax_code, country_code, COALESCE(organization_id::text, 'global')),
            ', ')
          FROM orphans)
  END AS pack_deductibility_contract;

-- Hard-fail (rollback with error) when orphans exist, so CI catches drift.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM public.payroll_statutory_rules it
  CROSS JOIN LATERAL jsonb_array_elements_text(
    COALESCE(it.parameters->'pre_tax_deductions', '[]'::jsonb)
  ) AS x(code)
  WHERE it.rule_type = 'income_tax'
    AND it.is_active = true
    AND lower(x.code) NOT IN (
      'insurance_premium','ahr_contribution','mortgage_interest',
      'pension_contribution','post_retirement_medical'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.payroll_statutory_rules s
      WHERE s.is_active = true
        AND s.organization_id IS NOT DISTINCT FROM it.organization_id
        AND s.country_code = it.country_code
        AND lower(s.rule_code) = lower(x.code)
        AND COALESCE((s.parameters->>'reduces_taxable_income')::boolean, false) = true
    );
  IF n > 0 THEN
    RAISE EXCEPTION
      'Pack deductibility contract violated: % orphan pre_tax_deductions codes', n;
  END IF;
END $$;

ROLLBACK;
