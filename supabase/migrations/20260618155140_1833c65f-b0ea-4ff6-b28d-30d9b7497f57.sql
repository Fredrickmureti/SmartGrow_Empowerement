
-- 1. Deduplicate KE active rules: pick the row that matches current KRA/NSSF caps.
--    Selection rule per rule_code:
--      nssf         -> the row whose tiers upper_earnings_limit = 108000 (post-Feb-2025 cap)
--      others       -> the row with the highest id::text (stable arbitrary tiebreaker),
--                      since their parameters are identical across duplicates.
WITH ke_rules AS (
  SELECT id, rule_code, parameters,
         row_number() OVER (
           PARTITION BY rule_code
           ORDER BY
             -- Prefer NSSF row that uses the new 108k cap
             CASE
               WHEN rule_code = 'nssf'
                    AND (parameters->'tiers'->1->>'upper_earnings_limit')::numeric = 108000
               THEN 0 ELSE 1
             END,
             created_at DESC NULLS LAST,
             id DESC
         ) AS rn
  FROM public.payroll_statutory_rules
  WHERE country_code = 'KE'
    AND is_active = true
    AND (effective_to IS NULL OR effective_to >= current_date)
)
UPDATE public.payroll_statutory_rules r
SET is_active = false,
    effective_to = COALESCE(r.effective_to, current_date - 1)
FROM ke_rules k
WHERE r.id = k.id
  AND k.rn > 1;

-- 2. Flag KE deductibles so the engine subtracts them from the PAYE base.
UPDATE public.payroll_statutory_rules
SET parameters = parameters || jsonb_build_object('reduces_taxable_income', true)
WHERE country_code = 'KE'
  AND is_active = true
  AND rule_code IN ('nssf', 'shif', 'housing_levy')
  AND COALESCE((parameters->>'reduces_taxable_income')::boolean, false) = false;

-- 3. Prevent the duplication regression: one active row per (country, rule_code).
CREATE UNIQUE INDEX IF NOT EXISTS payroll_statutory_rules_country_code_active_uniq
  ON public.payroll_statutory_rules (country_code, rule_code)
  WHERE is_active = true;
