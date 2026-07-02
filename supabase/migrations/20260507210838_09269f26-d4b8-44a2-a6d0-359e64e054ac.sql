-- Rewrite assert_payroll_ready and refresh_payroll_setup_status to use
-- default_account_settings instead of the dropped payroll_account_mappings table.

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

CREATE OR REPLACE FUNCTION public.refresh_payroll_setup_status(
  p_org_id uuid,
  p_business_id uuid DEFAULT NULL::uuid
)
RETURNS app_setup_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_reasons jsonb := '[]'::jsonb;
  v_row public.app_setup_status;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.installed_localization_packs WHERE organization_id = p_org_id) THEN
    v_reasons := v_reasons || jsonb_build_array('localization pack');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
    v_reasons := v_reasons || jsonb_build_array('salary structure');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.default_account_settings
    WHERE organization_id = p_org_id
      AND account_id IS NOT NULL
      AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
  ) THEN
    v_reasons := v_reasons || jsonb_build_array('payroll account mappings');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.payroll_statutory_rules
    WHERE organization_id = p_org_id
      AND is_active = true
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ) THEN
    v_reasons := v_reasons || jsonb_build_array('statutory rules');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.employee_contracts
    WHERE organization_id = p_org_id
      AND status IN ('running', 'new', 'active')
      AND (p_business_id IS NULL OR business_id = p_business_id)
  ) THEN
    v_reasons := v_reasons || jsonb_build_array('active employee contract');
  END IF;

  INSERT INTO public.app_setup_status (organization_id, app_id, status, blocking_reasons, last_checked_at)
  VALUES (p_org_id, 'payroll', CASE WHEN jsonb_array_length(v_reasons) = 0 THEN 'ready' ELSE 'incomplete' END, v_reasons, now())
  ON CONFLICT (organization_id, app_id) DO UPDATE SET
    status = EXCLUDED.status,
    blocking_reasons = EXCLUDED.blocking_reasons,
    last_checked_at = now(),
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.assert_payroll_ready(uuid, uuid, uuid[], date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_payroll_setup_status(uuid, uuid) TO authenticated;