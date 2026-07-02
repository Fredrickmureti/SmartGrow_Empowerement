-- ── Fix 1: validate_payroll_run_mappings was querying the dropped
--    payroll_account_mappings table. Rewrite against default_account_settings
--    (setting_key column), the live single source of truth.

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

  IF NOT public.is_org_member(v_run.organization_id) THEN
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

-- ── Fix 2: synthetic pre-run coverage check.
--    Given an org/business, derive the keys that WILL be needed based on
--    active statutory rules + active salary-component deductions/employer
--    contributions. Lets a Setup screen tell the payroll officer what to
--    map BEFORE creating any run.

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
  IF NOT public.is_org_member(p_org_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Statutory rules: every active rule contributes a *_payable key, and
  -- rules that carry an employer leg add *_expense.
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

  -- Salary-structure components: deductions need *_payable, employer
  -- contributions need *_expense + *_payable.
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