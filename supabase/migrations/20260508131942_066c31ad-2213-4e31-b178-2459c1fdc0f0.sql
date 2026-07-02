
-- ─── Stage 1A: fix validate_payroll_run_mappings authorization ───
-- The previous body called public.is_org_member(v_run.organization_id) with one arg.
-- The live signature is public.is_org_member(_user_id uuid, _organization_id uuid).
-- Same bug existed in preflight_payroll_account_coverage.

CREATE OR REPLACE FUNCTION public.validate_payroll_run_mappings(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_run            payroll_runs%ROWTYPE;
  v_required_keys  text[] := ARRAY['salary_expense', 'net_salary_payable'];
  v_used_keys      text[] := ARRAY[]::text[];
  v_existing_keys  text[];
  v_missing_keys   text[];
  v_dd             jsonb;
  v_cd             jsonb;
  v_key            text;
BEGIN
  SELECT * INTO v_run FROM payroll_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'missing_keys', ARRAY[]::text[],
      'summary', 'Payroll run not found'
    );
  END IF;

  IF auth.uid() IS NULL OR NOT public.is_org_member(auth.uid(), v_run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to validate this payroll run';
  END IF;

  FOR v_dd, v_cd IN
    SELECT
      COALESCE(deductions_detail::jsonb, '{}'::jsonb),
      COALESCE(contributions_detail::jsonb, '{}'::jsonb)
    FROM payslips
    WHERE payroll_run_id = p_run_id
  LOOP
    FOR v_key IN SELECT jsonb_object_keys(v_dd) LOOP
      IF (v_dd ->> v_key)::numeric > 0 THEN
        v_used_keys := v_used_keys || (v_key || '_payable');
      END IF;
    END LOOP;
    FOR v_key IN SELECT jsonb_object_keys(v_cd) LOOP
      IF (v_cd ->> v_key)::numeric > 0 THEN
        v_used_keys := v_used_keys || (v_key || '_expense');
        v_used_keys := v_used_keys || (v_key || '_payable');
      END IF;
    END LOOP;
  END LOOP;

  v_required_keys := (
    SELECT ARRAY(SELECT DISTINCT unnest(v_required_keys || v_used_keys))
  );

  SELECT ARRAY(
    SELECT DISTINCT setting_key
    FROM default_account_settings
    WHERE organization_id = v_run.organization_id
      AND (business_id IS NULL OR business_id = v_run.business_id)
      AND account_id IS NOT NULL
  ) INTO v_existing_keys;

  v_missing_keys := ARRAY(
    SELECT k
    FROM unnest(v_required_keys) AS k
    WHERE k <> ALL(COALESCE(v_existing_keys, ARRAY[]::text[]))
      AND CASE
            WHEN k LIKE '%_payable' THEN
              regexp_replace(k, '_payable$', '') <> ALL(COALESCE(v_existing_keys, ARRAY[]::text[]))
            ELSE true
          END
  );

  RETURN jsonb_build_object(
    'ok', cardinality(v_missing_keys) = 0,
    'missing_keys', v_missing_keys,
    'required_keys', v_required_keys,
    'existing_keys', COALESCE(v_existing_keys, ARRAY[]::text[]),
    'summary', CASE
      WHEN cardinality(v_missing_keys) = 0
        THEN 'All required account mappings are configured.'
      ELSE format('%s mapping(s) missing — configure them in Payroll Settings → Account Mappings.', cardinality(v_missing_keys))
    END
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.validate_payroll_run_mappings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.preflight_payroll_account_coverage(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_required text[] := ARRAY['salary_expense', 'net_salary_payable'];
  v_existing text[];
  v_missing  text[];
  v_rule     RECORD;
  v_comp     RECORD;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_org_member(auth.uid(), p_org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR v_rule IN
    SELECT rule_type, parameters
    FROM payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND (business_id IS NULL OR business_id = p_business_id)
      AND is_active = true
      AND COALESCE(effective_to, CURRENT_DATE) >= CURRENT_DATE
  LOOP
    v_required := v_required || (v_rule.rule_type || '_payable');
    IF COALESCE((v_rule.parameters->>'employer_rate')::numeric, 0) > 0
       OR COALESCE((v_rule.parameters->>'employer_amount')::numeric, 0) > 0
       OR (v_rule.parameters ? 'employer') THEN
      v_required := v_required || (v_rule.rule_type || '_expense');
    END IF;
  END LOOP;

  FOR v_comp IN
    SELECT DISTINCT sc.code, sc.component_type
    FROM salary_components sc
    JOIN salary_structures ss ON ss.id = sc.structure_id
    WHERE sc.organization_id = p_org_id
      AND (ss.business_id IS NULL OR ss.business_id = p_business_id)
      AND sc.is_active = true
      AND ss.is_active = true
      AND sc.component_type IN ('deduction', 'employer_contribution')
  LOOP
    IF v_comp.component_type = 'deduction' THEN
      v_required := v_required || (lower(v_comp.code) || '_payable');
    ELSE
      v_required := v_required || (lower(v_comp.code) || '_expense');
      v_required := v_required || (lower(v_comp.code) || '_payable');
    END IF;
  END LOOP;

  v_required := (SELECT ARRAY(SELECT DISTINCT unnest(v_required)));

  SELECT ARRAY(
    SELECT DISTINCT setting_key
    FROM default_account_settings
    WHERE organization_id = p_org_id
      AND (business_id IS NULL OR business_id = p_business_id)
      AND account_id IS NOT NULL
  ) INTO v_existing;

  v_missing := ARRAY(
    SELECT k
    FROM unnest(v_required) AS k
    WHERE k <> ALL(COALESCE(v_existing, ARRAY[]::text[]))
      AND CASE
            WHEN k LIKE '%_payable' THEN
              regexp_replace(k, '_payable$', '') <> ALL(COALESCE(v_existing, ARRAY[]::text[]))
            ELSE true
          END
  );

  RETURN jsonb_build_object(
    'ok', cardinality(v_missing) = 0,
    'required_keys', v_required,
    'existing_keys', COALESCE(v_existing, ARRAY[]::text[]),
    'missing_keys', v_missing
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.preflight_payroll_account_coverage(uuid, uuid) TO authenticated;

-- ─── Stage 2A: per-statutory-rule unique code ───
-- Multiple distinct rules share rule_type='statutory_deduction' (NSSF, SHIF, AHL, NHIF...).
-- Engine downstream keys off rule_code; without a per-rule code those collapse into one
-- bucket on payslips, GL, and reports. Add an explicit, stable rule_code column.

ALTER TABLE public.payroll_statutory_rules
  ADD COLUMN IF NOT EXISTS rule_code text;

-- Helper: deterministic slug from rule_name (lowercase, underscores, ascii-ish).
CREATE OR REPLACE FUNCTION public.payroll_rule_slug(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
           regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '_', 'g'),
           '(^_+|_+$)', '', 'g'
         );
$$;

-- Backfill: prefer parameters->>'code' if a localization pack already shipped one,
-- otherwise slug the rule_name. Falls back to rule_type as a last resort.
UPDATE public.payroll_statutory_rules
   SET rule_code = COALESCE(
         NULLIF(parameters->>'code', ''),
         NULLIF(public.payroll_rule_slug(rule_name), ''),
         rule_type
       )
 WHERE rule_code IS NULL;

ALTER TABLE public.payroll_statutory_rules
  ALTER COLUMN rule_code SET NOT NULL;

-- Avoid duplicate active rule_code per (org, business). business_id may be NULL
-- for org-wide rules, so split into two partial indexes.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_rule_code_active_business
  ON public.payroll_statutory_rules (organization_id, business_id, rule_code)
  WHERE is_active = true AND business_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_payroll_rule_code_active_orgwide
  ON public.payroll_statutory_rules (organization_id, rule_code)
  WHERE is_active = true AND business_id IS NULL;

-- ─── Stage 3A: deactivate legacy NHIF rules wherever SHIF is also active ───
-- Localization pack left both turned on. SHIF replaced NHIF in Oct 2024 — running
-- both double-deducts the employee. Keep historical rows; just stop computing them.
UPDATE public.payroll_statutory_rules nhif
   SET is_active = false,
       updated_at = now()
 WHERE is_active = true
   AND (parameters->>'status') = 'replaced_by_shif'
   AND EXISTS (
     SELECT 1 FROM public.payroll_statutory_rules shif
      WHERE shif.organization_id = nhif.organization_id
        AND COALESCE(shif.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = COALESCE(nhif.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND shif.is_active = true
        AND lower(shif.rule_name) LIKE 'shif%'
   );
