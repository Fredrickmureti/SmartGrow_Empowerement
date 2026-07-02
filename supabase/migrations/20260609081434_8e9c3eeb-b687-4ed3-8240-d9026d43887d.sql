
-- ============================================================
-- Wave J3 — wire hr_statutory_field_config into onboarding & payroll readiness
-- ============================================================

-- 1) Extend hr_apply_default_onboarding so newly-hired employees automatically
--    get one onboarding checklist item per required statutory field they
--    don't yet have a value for. The trigger is owner-defined and runs after
--    insert on public.employees.
CREATE OR REPLACE FUNCTION public.hr_apply_default_onboarding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tpl uuid;
  v_onboarding_id uuid;
BEGIN
  SELECT default_onboarding_template_id INTO v_tpl
    FROM public.hr_policies
   WHERE business_id = NEW.business_id;

  -- Always create an onboarding header so statutory items have a parent,
  -- even when no default template is configured.
  INSERT INTO public.employee_onboarding (
    organization_id, business_id, employee_id, template_id,
    onboarding_type, status, started_at
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.id, v_tpl,
    'onboarding', 'in_progress', now()
  )
  RETURNING id INTO v_onboarding_id;

  -- Template items (if a template is set)
  IF v_tpl IS NOT NULL THEN
    INSERT INTO public.employee_onboarding_items (
      onboarding_id, title, description, category, sort_order, is_completed
    )
    SELECT v_onboarding_id, title, description, COALESCE(category,'general'),
           sort_order, false
      FROM public.onboarding_template_items
     WHERE template_id = v_tpl
     ORDER BY sort_order;
  END IF;

  -- Required statutory-field items (one per missing identifier)
  INSERT INTO public.employee_onboarding_items (
    onboarding_id, title, description, category, sort_order, is_completed
  )
  SELECT
    v_onboarding_id,
    'Collect ' || COALESCE(c.label, c.identifier_type),
    COALESCE(c.help_text,
      'Required statutory identifier (' || c.identifier_type || ').'),
    'statutory',
    1000 + c.sort_order,
    false
    FROM public.hr_statutory_field_config c
   WHERE c.business_id = NEW.business_id
     AND c.is_active = true
     AND c.blocks_onboarding = true
     AND NOT EXISTS (
       SELECT 1 FROM public.employee_statutory_identifiers esi
        WHERE esi.employee_id = NEW.id
          AND esi.identifier_type = c.identifier_type
          AND COALESCE(esi.identifier_value, '') <> ''
     );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'hr_apply_default_onboarding skipped for employee %: %', NEW.id, sqlerrm;
  RETURN NEW;
END;
$$;

-- 2) Teach the payroll readiness evaluator about a new employee-scope
--    check that reads hr_statutory_field_config dynamically.
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule public.payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
) RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text := 'pass';
  v_reason text;
  v_missing text[] := ARRAY[]::text[];
  v_details jsonb := '{}'::jsonb;
  v_invalid text;
BEGIN
  -- Delegate to the existing implementation by re-issuing the same CASE.
  -- We only add a new branch; everything else falls through to a generic
  -- predicate_sql evaluator at the bottom (existing behaviour preserved
  -- by the prior version of this function — see migration 20260607010707).
  CASE p_rule.check_kind

  WHEN 'employee.statutory_fields_required' THEN
    SELECT COALESCE(array_agg(c.identifier_type ORDER BY c.sort_order), ARRAY[]::text[])
      INTO v_missing
      FROM public.hr_statutory_field_config c
     WHERE c.business_id = COALESCE(
              p_business_id,
              (SELECT business_id FROM public.employees WHERE id = p_subject_id)
           )
       AND c.is_active = true
       AND c.blocks_payroll = true
       AND NOT EXISTS (
         SELECT 1 FROM public.employee_statutory_identifiers esi
          WHERE esi.employee_id = p_subject_id
            AND esi.identifier_type = c.identifier_type
            AND COALESCE(esi.identifier_value, '') <> ''
       );
    IF array_length(v_missing, 1) IS NOT NULL THEN
      v_status := 'fail';
      v_reason := 'Required statutory identifiers missing: ' || array_to_string(v_missing, ', ');
      v_details := jsonb_build_object('missing', v_missing);
    END IF;

  ELSE
    -- Fall back to original evaluator for every other check_kind by calling
    -- the existing function under a different name. We keep the original
    -- function body intact via this internal re-call.
    SELECT * INTO v_status, v_reason, v_missing, v_details
      FROM public._payroll_readiness_eval_rule_core(
        p_rule, p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end
      );
  END CASE;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$$;

-- 3) Seed a global core readiness rule (organization_id NULL applies to all orgs).
INSERT INTO public.payroll_readiness_rules (
  organization_id, code, name, description, scope, severity, source,
  reason_code, check_kind, remediation_label, remediation_link,
  is_active, sort_order
) VALUES (
  NULL,
  'core.employee.statutory_fields_required',
  'Required statutory identifiers present',
  'Every statutory field marked "Blocks payroll" must have a value on the employee.',
  'employee', 'block', 'core',
  'EMPLOYEE_STATUTORY_FIELDS_MISSING',
  'employee.statutory_fields_required',
  'Open employee profile',
  '/hr/employees',
  true, 220
)
ON CONFLICT (organization_id, code) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      scope = EXCLUDED.scope,
      severity = EXCLUDED.severity,
      source = EXCLUDED.source,
      reason_code = EXCLUDED.reason_code,
      check_kind = EXCLUDED.check_kind,
      remediation_label = EXCLUDED.remediation_label,
      remediation_link = EXCLUDED.remediation_link,
      is_active = true,
      updated_at = now();
