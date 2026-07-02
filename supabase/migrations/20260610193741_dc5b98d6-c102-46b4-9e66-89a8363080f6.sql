
-- 1) Rewrite the statutory readiness rule to consult pack_requirements with override priority
CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule payroll_readiness_rules,
  p_org_id uuid,
  p_business_id uuid,
  p_subject_id uuid,
  p_period_start date,
  p_period_end date
)
RETURNS TABLE(status text, reason text, missing_fields text[], details jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text := 'pass';
  v_reason text;
  v_missing text[] := ARRAY[]::text[];
  v_details jsonb := '{}'::jsonb;
  v_invalid text;
  v_count int;
  v_business uuid;
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (SELECT 1 FROM installed_localization_packs WHERE organization_id = p_org_id) THEN
      v_status := 'fail'; v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (SELECT 1 FROM salary_structures WHERE organization_id = p_org_id AND is_active = true) THEN
      v_status := 'fail'; v_reason := 'No active salary structure has been defined.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM default_account_settings
      WHERE organization_id = p_org_id AND account_id IS NOT NULL
        AND (p_business_id IS NULL OR business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll GL accounts have not been mapped.';
      v_missing := ARRAY['payroll_gl_accounts'];
    END IF;

  WHEN 'org.statutory_rules_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payroll_statutory_rules
      WHERE organization_id = p_org_id AND is_active = true
        AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
    ) THEN
      v_status := 'fail'; v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(rule_name, ', ' ORDER BY rule_name) INTO v_invalid
      FROM payroll_statutory_rules
     WHERE organization_id = p_org_id AND is_active = true
       AND (effective_to IS NULL OR effective_to >= COALESCE(p_period_end, CURRENT_DATE))
       AND (computation_method IS NULL OR lower(trim(computation_method)) IN ('','unknown','auto'));
    IF v_invalid IS NOT NULL AND length(v_invalid) > 0 THEN
      v_status := 'fail';
      v_reason := 'Statutory rules with invalid computation_method: ' || v_invalid;
      v_missing := ARRAY['statutory_rule_method'];
      v_details := jsonb_build_object('invalid_rules', v_invalid);
    END IF;

  WHEN 'org.payroll_period_exists' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payroll_periods
      WHERE organization_id = p_org_id
        AND (p_business_id IS NULL OR business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'No payroll periods have been generated.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  WHEN 'employee.active_contract' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active')
        AND (p_business_id IS NULL OR ec.business_id = p_business_id)
        AND (p_period_end IS NULL OR ec.start_date <= p_period_end)
        AND (p_period_start IS NULL OR ec.end_date IS NULL OR ec.end_date >= p_period_start)
    ) THEN
      v_status := 'fail'; v_reason := 'Employee has no active contract for the period.';
      v_missing := ARRAY['employee_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active') AND COALESCE(ec.wage, 0) > 0
    ) THEN
      v_status := 'fail'; v_reason := 'Active contract has no wage / salary amount.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employee_contracts ec
      WHERE ec.organization_id = p_org_id AND ec.employee_id = p_subject_id
        AND ec.status IN ('running','new','active') AND ec.working_schedule IS NOT NULL
    ) THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['contract_schedule'];
    END IF;

  WHEN 'employee.has_statutory_identifiers' THEN
    IF NOT EXISTS (SELECT 1 FROM employee_statutory_identifiers WHERE employee_id = p_subject_id) THEN
      v_status := 'warn'; v_reason := 'Employee has no statutory identifiers recorded.';
      v_missing := ARRAY['statutory_identifiers'];
    END IF;

  WHEN 'employee.has_payment_info' THEN
    IF NOT EXISTS (
      SELECT 1 FROM employees
      WHERE id = p_subject_id
        AND (bank_account_number IS NOT NULL OR bank_name IS NOT NULL)
    ) THEN
      v_status := 'warn'; v_reason := 'Employee has no bank / payment information.';
      v_missing := ARRAY['payment_info'];
    END IF;

  WHEN 'employee.statutory_fields_required' THEN
    -- NEW: drive from pack_requirements (single source of truth), with
    -- tenant_override winning over pack rows via DISTINCT ON priority.
    v_business := COALESCE(
      p_business_id,
      (SELECT business_id FROM public.employees WHERE id = p_subject_id)
    );
    SELECT COALESCE(array_agg(req.requirement_key ORDER BY req.sort_order), ARRAY[]::text[])
      INTO v_missing
    FROM (
      SELECT DISTINCT ON (requirement_key)
        requirement_key, sort_order, is_required, is_active, blocks_payroll
      FROM public.pack_requirements
      WHERE business_id = v_business
        AND scope = 'statutory_identifier'
      ORDER BY requirement_key,
        CASE source WHEN 'tenant_override' THEN 0 ELSE 1 END
    ) req
    WHERE req.is_active = true
      AND req.is_required = true
      AND req.blocks_payroll = true
      AND NOT EXISTS (
        SELECT 1 FROM public.employee_statutory_identifiers esi
        WHERE esi.employee_id = p_subject_id
          AND esi.identifier_type = req.requirement_key
          AND COALESCE(esi.identifier_value, '') <> ''
      );
    IF array_length(v_missing, 1) IS NOT NULL THEN
      v_status := 'fail';
      v_reason := 'Required statutory identifiers missing: ' || array_to_string(v_missing, ', ');
      v_details := jsonb_build_object('missing', v_missing, 'source', 'pack_requirements');
    END IF;

  WHEN 'run.period_not_closed' THEN
    IF EXISTS (
      SELECT 1 FROM payroll_runs pr
      JOIN fiscal_periods fp ON fp.organization_id = pr.organization_id
        AND fp.status = 'closed'
        AND pr.period_start BETWEEN fp.start_date AND fp.end_date
      WHERE pr.id = p_subject_id
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll period falls inside a closed fiscal period.';
      v_missing := ARRAY['fiscal_period_open'];
    END IF;

  WHEN 'run.no_duplicate_regular' THEN
    SELECT count(*) INTO v_count
      FROM payroll_runs pr
     WHERE pr.id <> p_subject_id AND pr.organization_id = p_org_id
       AND COALESCE(pr.run_type, 'regular') = 'regular'
       AND pr.status NOT IN ('cancelled','void')
       AND EXISTS (
         SELECT 1 FROM payroll_runs me
         WHERE me.id = p_subject_id
           AND me.period_start = pr.period_start
           AND me.period_end = pr.period_end
       );
    IF v_count > 0 THEN
      v_status := 'fail';
      v_reason := 'Another regular run already exists for this period.';
      v_missing := ARRAY['duplicate_run'];
      v_details := jsonb_build_object('conflicts', v_count);
    END IF;

  ELSE
    IF p_rule.predicate_sql IS NOT NULL AND length(trim(p_rule.predicate_sql)) > 0 THEN
      DECLARE v_ok boolean;
      BEGIN
        EXECUTE p_rule.predicate_sql INTO v_ok
          USING p_org_id, p_business_id, p_subject_id, p_period_start, p_period_end;
        IF NOT COALESCE(v_ok, false) THEN
          v_status := 'fail';
          v_reason := COALESCE(p_rule.description, p_rule.name);
          v_missing := ARRAY[p_rule.reason_code];
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_status := 'fail';
        v_reason := 'Readiness predicate raised: ' || SQLERRM;
        v_details := jsonb_build_object('sqlerrm', SQLERRM, 'sqlstate', SQLSTATE);
      END;
    ELSE
      v_status := 'skip';
      v_reason := 'Unknown check_kind and no predicate_sql; rule skipped.';
    END IF;
  END CASE;

  IF v_status = 'fail' AND p_rule.severity = 'warn' THEN
    v_status := 'warn';
  END IF;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$function$;

-- 2) Auto-sync pack onboarding-item requirements into the default onboarding template
CREATE OR REPLACE FUNCTION public.sync_pack_onboarding_items(p_business_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org_id uuid;
  v_template_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id FROM public.businesses WHERE id = p_business_id;
  IF v_org_id IS NULL THEN RETURN; END IF;

  -- Ensure a default onboarding template exists for this business
  SELECT id INTO v_template_id
    FROM public.onboarding_templates
   WHERE business_id = p_business_id AND template_type = 'onboarding' AND is_default = true
   LIMIT 1;

  IF v_template_id IS NULL THEN
    INSERT INTO public.onboarding_templates (organization_id, business_id, name, template_type, is_default, is_active)
    VALUES (v_org_id, p_business_id, 'Default Onboarding', 'onboarding', true, true)
    RETURNING id INTO v_template_id;
  END IF;

  -- Materialize pack onboarding items into the template
  INSERT INTO public.onboarding_template_items (template_id, title, description, category, sort_order, is_required)
  SELECT
    v_template_id,
    COALESCE(pr.label, pr.requirement_key) AS title,
    pr.help_text AS description,
    pr.module::text AS category,
    pr.sort_order,
    pr.is_required
  FROM (
    SELECT DISTINCT ON (requirement_key)
      requirement_key, label, help_text, module, sort_order, is_required, is_active
    FROM public.pack_requirements
    WHERE business_id = p_business_id
      AND scope = 'onboarding_item'
    ORDER BY requirement_key,
      CASE source WHEN 'tenant_override' THEN 0 ELSE 1 END
  ) pr
  WHERE pr.is_active = true
    AND NOT EXISTS (
      SELECT 1 FROM public.onboarding_template_items ti
      WHERE ti.template_id = v_template_id AND ti.title = COALESCE(pr.label, pr.requirement_key)
    );
END;
$function$;

-- 3) Trigger function: when a pack is (re)installed, sync onboarding items for every business in that org
CREATE OR REPLACE FUNCTION public.tg_sync_onboarding_after_pack()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
BEGIN
  FOR v_business_id IN
    SELECT id FROM public.businesses WHERE organization_id = NEW.organization_id
  LOOP
    PERFORM public.sync_pack_onboarding_items(v_business_id);
  END LOOP;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tg_installed_pack_sync_onboarding ON public.installed_localization_packs;
CREATE TRIGGER tg_installed_pack_sync_onboarding
AFTER INSERT OR UPDATE ON public.installed_localization_packs
FOR EACH ROW EXECUTE FUNCTION public.tg_sync_onboarding_after_pack();

-- 4) Backfill: sync onboarding items for every existing business that already has pack requirements
DO $$
DECLARE
  v_business_id uuid;
BEGIN
  FOR v_business_id IN
    SELECT DISTINCT business_id FROM public.pack_requirements WHERE scope = 'onboarding_item'
  LOOP
    PERFORM public.sync_pack_onboarding_items(v_business_id);
  END LOOP;
END $$;
