-- Tighten payroll readiness so silent zero-deduction runs become impossible.
-- Adds a check that every active statutory rule for the org has a recognized
-- computation_method; otherwise raise SETUP_REQUIRED with the offending rule
-- names so the existing PayrollSetupGuideDialog can guide the operator.

CREATE OR REPLACE FUNCTION public.assert_payroll_ready(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL::uuid,
  p_employee_ids uuid[] DEFAULT NULL::uuid[],
  p_period_start date DEFAULT NULL::date,
  p_period_end date DEFAULT NULL::date
)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_missing_contracts int := 0;
  v_invalid_rule_names text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.installed_localization_packs WHERE organization_id = p_org_id) THEN
    v_missing := array_append(v_missing, 'localization pack');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
    v_missing := array_append(v_missing, 'salary structure');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.default_account_settings
    WHERE organization_id = p_org_id
      AND account_id IS NOT NULL
      AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
  ) THEN
    v_missing := array_append(v_missing, 'payroll account mappings');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND is_active = true
      AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
  ) THEN
    v_missing := array_append(v_missing, 'statutory rules');
  ELSE
    -- Any active rule whose computation_method is unknown/auto/blank would be
    -- silently skipped by compute-payroll. Refuse to run and name them so the
    -- operator can fix the rule (or reinstall the localization pack).
    SELECT string_agg(rule_name, ', ' ORDER BY rule_name)
      INTO v_invalid_rule_names
    FROM public.payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND is_active = true
      AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
      AND (
        computation_method IS NULL
        OR lower(trim(computation_method)) IN ('', 'unknown', 'auto')
      );

    IF v_invalid_rule_names IS NOT NULL AND length(v_invalid_rule_names) > 0 THEN
      v_missing := array_append(
        v_missing,
        'statutory rule computation method (invalid for: ' || v_invalid_rule_names || ')'
      );
    END IF;
  END IF;

  IF p_employee_ids IS NULL OR array_length(p_employee_ids, 1) IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.employee_contracts
      WHERE organization_id = p_org_id
        AND status IN ('running', 'new', 'active')
        AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_missing := array_append(v_missing, 'active employee contract');
    END IF;
  ELSE
    SELECT count(*) INTO v_missing_contracts
    FROM unnest(p_employee_ids) AS selected(employee_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.employee_contracts ec
      WHERE ec.organization_id = p_org_id
        AND ec.employee_id = selected.employee_id
        AND ec.status IN ('running', 'new', 'active')
        AND (p_business_id IS NULL OR ec.business_id = p_business_id)
        AND (p_period_end IS NULL OR ec.start_date <= p_period_end)
        AND (p_period_start IS NULL OR ec.end_date IS NULL OR ec.end_date >= p_period_start)
    );

    IF v_missing_contracts > 0 THEN
      v_missing := array_append(v_missing, v_missing_contracts || ' selected employee(s) without active period contract');
    END IF;
  END IF;

  IF array_length(v_missing, 1) IS NULL THEN
    RETURN true;
  END IF;

  RAISE EXCEPTION 'SETUP_REQUIRED: Payroll cannot run yet. Missing: %.', array_to_string(v_missing, ', ')
    USING ERRCODE = 'P0001', HINT = 'payroll_setup_incomplete';
END;
$function$;