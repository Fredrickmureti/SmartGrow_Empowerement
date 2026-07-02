-- Shape guard for `bracket_progressive` localization pack rules.
--
-- The generic compute-payroll evaluator accepts either `max` or `upper` as
-- the tier ceiling alias. A bracket with NEITHER alias collapses to an
-- unbounded tier, which historically caused every progressive tax to be
-- charged at tier-1 only (the entire taxable income at 10% for KE PAYE,
-- producing under-collection across countries). This test fails fast when
-- any active pack row ships a malformed brackets array, regardless of
-- country.
--
-- Pure structural assertion — no country-specific logic.

DO $$
DECLARE
  bad_count int;
  bad_sample jsonb;
BEGIN
  WITH active_progressive AS (
    SELECT id, rule_code, rule_name, country_code, parameters
    FROM public.payroll_statutory_rules
    WHERE lower(coalesce(computation_method, '')) = 'bracket_progressive'
      AND (effective_to IS NULL OR effective_to >= current_date)
  ),
  exploded AS (
    SELECT
      ap.id,
      ap.rule_code,
      ap.country_code,
      idx,
      bracket,
      (SELECT count(*) FROM jsonb_array_elements(ap.parameters->'brackets')) AS tier_count
    FROM active_progressive ap,
         LATERAL jsonb_array_elements(ap.parameters->'brackets') WITH ORDINALITY AS t(bracket, idx)
  ),
  malformed AS (
    SELECT *
    FROM exploded
    WHERE
      -- Every NON-TOP tier must declare a finite ceiling via `max` or `upper`.
      -- The top tier (idx = tier_count) is allowed to be open-ended.
      idx < tier_count
      AND (bracket->>'max') IS NULL
      AND (bracket->>'upper') IS NULL
  )
  SELECT count(*), (SELECT jsonb_build_object(
      'rule_code', rule_code,
      'country_code', country_code,
      'tier_index', idx,
      'bracket', bracket
    ) FROM malformed LIMIT 1)
  INTO bad_count, bad_sample
  FROM malformed;

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'bracket_progressive pack-shape violation: % non-top tier(s) missing both `max` and `upper`. Sample: %',
      bad_count, bad_sample;
  END IF;
END$$;

-- Also assert that brackets is a non-empty JSON array on every active rule.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*)
  INTO bad_count
  FROM public.payroll_statutory_rules
  WHERE lower(coalesce(computation_method, '')) = 'bracket_progressive'
    AND (effective_to IS NULL OR effective_to >= current_date)
    AND (
      jsonb_typeof(parameters->'brackets') IS DISTINCT FROM 'array'
      OR jsonb_array_length(parameters->'brackets') = 0
    );

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'bracket_progressive pack-shape violation: % active rule(s) have empty or non-array parameters.brackets.',
      bad_count;
  END IF;
END$$;