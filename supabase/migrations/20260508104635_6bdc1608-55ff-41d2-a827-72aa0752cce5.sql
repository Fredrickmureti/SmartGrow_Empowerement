
-- =========================================================================
-- Payroll engine ↔ localization pack contract alignment.
--
-- Adds explicit `computation_method` to localization pack templates and
-- backfills it for both pack templates and already-installed statutory
-- rules. The compute-payroll engine no longer guesses a method from the
-- shape of `parameters` — packs and rules MUST declare it explicitly.
-- =========================================================================

-- 1. Add computation_method to pack templates.
ALTER TABLE public.localization_pack_payroll_templates
  ADD COLUMN IF NOT EXISTS computation_method text NOT NULL DEFAULT 'auto';

-- 2. Helper: infer the right method from parameter shape + rule_type/name.
CREATE OR REPLACE FUNCTION public._infer_payroll_computation_method(
  p_rule_type text,
  p_rule_name text,
  p_params    jsonb
) RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  first_bracket jsonb;
BEGIN
  IF p_params IS NULL THEN RETURN 'auto'; END IF;

  -- Brackets: progressive (rate per bracket) vs graduated_table (amount per bracket)
  IF p_params ? 'brackets' AND jsonb_typeof(p_params->'brackets') = 'array'
     AND jsonb_array_length(p_params->'brackets') > 0 THEN
    first_bracket := p_params->'brackets'->0;
    IF first_bracket ? 'rate' THEN
      RETURN 'bracket_progressive';
    ELSIF first_bracket ? 'amount' THEN
      RETURN 'graduated_table';
    END IF;
  END IF;

  -- Tiered (NSSF-style)
  IF p_params ? 'tiers' AND jsonb_typeof(p_params->'tiers') = 'array' THEN
    RETURN 'tiered_brackets';
  END IF;

  -- Per-employee flat (NITA-style)
  IF p_params ? 'amount_per_employee' THEN
    RETURN 'per_employee_flat';
  END IF;

  -- Percentage of some base
  IF p_params ? 'rate' OR p_params ? 'employee_rate' OR p_params ? 'employer_rate' THEN
    RETURN 'percentage_of_gross';
  END IF;

  -- Pure flat amount
  IF p_params ? 'amount' THEN
    RETURN 'flat_amount';
  END IF;

  RETURN 'auto';
END
$$;

-- 3. Backfill pack templates.
UPDATE public.localization_pack_payroll_templates
SET    computation_method = public._infer_payroll_computation_method(rule_type, rule_name, parameters)
WHERE  computation_method = 'auto';

-- 4. Backfill installed statutory rules (only those still on 'auto').
UPDATE public.payroll_statutory_rules
SET    computation_method = public._infer_payroll_computation_method(rule_type, rule_name, parameters)
WHERE  computation_method IS NULL OR computation_method = 'auto';

-- 5. Drop the helper — single-use migration aid.
DROP FUNCTION public._infer_payroll_computation_method(text, text, jsonb);
