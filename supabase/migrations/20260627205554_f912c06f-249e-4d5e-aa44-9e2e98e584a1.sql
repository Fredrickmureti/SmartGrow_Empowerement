-- ============================================================================
-- Employee Draft Lifecycle Hardening
-- See migration description for rationale. Summary:
--   1. Fix 42702 in payroll_readiness_eval_rule by renaming OUT params and
--      fully qualifying column references.
--   2. Make the five employee provisioning triggers skip drafts and fire on
--      the draft -> active promotion instead.
-- ============================================================================

-- 1. payroll_readiness_eval_rule -------------------------------------------------
DROP FUNCTION IF EXISTS public.payroll_readiness_eval_rule(
  public.payroll_readiness_rules, uuid, uuid, uuid, date, date
);

CREATE OR REPLACE FUNCTION public.payroll_readiness_eval_rule(
  p_rule          public.payroll_readiness_rules,
  p_org_id        uuid,
  p_business_id   uuid,
  p_subject_id    uuid,
  p_period_start  date,
  p_period_end    date
)
RETURNS TABLE (
  out_status         text,
  out_reason         text,
  out_missing_fields text[],
  out_details        jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status     text := 'pass';
  v_reason     text;
  v_missing    text[] := ARRAY[]::text[];
  v_details    jsonb := '{}'::jsonb;
  v_invalid    text;
  v_c          public.employee_contracts;
  v_components jsonb;
BEGIN
  CASE p_rule.check_kind

  WHEN 'org.localization_pack_installed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.installed_localization_packs ilp
      WHERE ilp.organization_id = p_org_id
    ) THEN
      v_status := 'fail'; v_reason := 'No localization pack installed for this organization.';
      v_missing := ARRAY['localization_pack'];
    END IF;

  WHEN 'org.salary_structure_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.salary_structures ss
      WHERE ss.organization_id = p_org_id AND ss.is_active = true
    ) THEN
      v_status := 'fail'; v_reason := 'No active salary structure has been defined org-wide.';
      v_missing := ARRAY['salary_structure'];
    END IF;

  WHEN 'org.payroll_accounts_mapped' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.default_account_settings das
      WHERE das.organization_id = p_org_id
        AND das.account_id IS NOT NULL
        AND (p_business_id IS NULL OR das.business_id IS NULL OR das.business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'Payroll GL accounts have not been mapped.';
      v_missing := ARRAY['payroll_gl_accounts'];
    END IF;

  WHEN 'org.statutory_rules_active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_statutory_rules psr
      WHERE psr.organization_id = p_org_id AND psr.is_active = true
        AND (psr.effective_to IS NULL OR psr.effective_to >= COALESCE(p_period_end, CURRENT_DATE))
    ) THEN
      v_status := 'fail'; v_reason := 'No active statutory rules in effect for the period.';
      v_missing := ARRAY['statutory_rules'];
    END IF;

  WHEN 'org.statutory_rules_valid_method' THEN
    SELECT string_agg(psr.rule_name, ', ' ORDER BY psr.rule_name) INTO v_invalid
    FROM public.payroll_statutory_rules psr
    WHERE psr.organization_id = p_org_id AND psr.is_active = true
      AND (psr.effective_to IS NULL OR psr.effective_to >= COALESCE(p_period_end, CURRENT_DATE))
      AND (psr.computation_method IS NULL
           OR lower(trim(psr.computation_method)) IN ('','unknown','auto'));
    IF v_invalid IS NOT NULL AND length(v_invalid) > 0 THEN
      v_status := 'fail'; v_reason := 'Statutory rules with invalid computation_method: ' || v_invalid;
      v_missing := ARRAY['statutory_rule_method'];
      v_details := jsonb_build_object('invalid_rules', v_invalid);
    END IF;

  WHEN 'org.payroll_period_exists' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.payroll_periods pp
      WHERE pp.organization_id = p_org_id
        AND (p_business_id IS NULL OR pp.business_id = p_business_id)
    ) THEN
      v_status := 'fail'; v_reason := 'No payroll periods generated yet.';
      v_missing := ARRAY['payroll_periods'];
    END IF;

  WHEN 'employee.active_contract' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.employee_contracts ec
      WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
    ) THEN
      v_status := 'fail'; v_reason := 'No active (running) contract for this employee.';
      v_missing := ARRAY['active_contract'];
    END IF;

  WHEN 'employee.contract_has_salary' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF FOUND AND COALESCE(v_c.wage, 0) <= 0 AND v_c.salary_structure_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has neither a wage nor a salary structure.';
      v_missing := ARRAY['contract_wage'];
    END IF;

  WHEN 'employee.contract_has_schedule' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF FOUND AND v_c.work_schedule_id IS NULL THEN
      v_status := 'fail'; v_reason := 'Active contract has no working schedule.';
      v_missing := ARRAY['work_schedule'];
    END IF;

  WHEN 'employee.compensation_mode_set' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF NOT FOUND THEN
      v_status := 'fail'; v_reason := 'No active contract for employee.';
      v_missing := ARRAY['contract'];
    ELSIF v_c.compensation_mode IS NULL THEN
      v_status := 'fail'; v_reason := 'Contract has no compensation method (structure or simple wage).';
      v_missing := ARRAY['compensation_mode'];
    END IF;

  WHEN 'employee.salary_structure_resolves' THEN
    SELECT ec.* INTO v_c FROM public.employee_contracts ec
     WHERE ec.employee_id = p_subject_id AND ec.status = 'running'
     ORDER BY ec.start_date DESC NULLS LAST LIMIT 1;
    IF FOUND AND v_c.compensation_mode = 'structure' THEN
      IF v_c.salary_structure_id IS NULL THEN
        v_status := 'fail'; v_reason := 'Structure-mode contract has no salary structure selected.';
        v_missing := ARRAY['salary_structure_id'];
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.salary_structures ss
        WHERE ss.id = v_c.salary_structure_id AND ss.is_active = true
      ) THEN
        v_status := 'fail'; v_reason := 'Selected salary structure is inactive.';
        v_missing := ARRAY['salary_structure_active'];
      ELSE
        SELECT public.canonicalise_salary_components(v_c.salary_structure_id) INTO v_components;
        IF COALESCE(v_components, '[]'::jsonb) = '[]'::jsonb THEN
          v_status := 'fail'; v_reason := 'Selected salary structure has no active components.';
          v_missing := ARRAY['salary_components'];
        END IF;
      END IF;
    END IF;

  ELSE
    NULL;
  END CASE;

  RETURN QUERY SELECT v_status, v_reason, v_missing, v_details;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.payroll_readiness_eval_rule(
  public.payroll_readiness_rules, uuid, uuid, uuid, date, date
) TO authenticated, service_role;

-- evaluate_payroll_readiness_quiet must reference the new OUT names.
CREATE OR REPLACE FUNCTION public.evaluate_payroll_readiness_quiet(
  p_org_id        uuid,
  p_business_id   uuid DEFAULT NULL::uuid,
  p_scope         text DEFAULT 'org'::text,
  p_subject_ids   uuid[] DEFAULT NULL::uuid[],
  p_period_start  date DEFAULT NULL::date,
  p_period_end    date DEFAULT NULL::date
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule     public.payroll_readiness_rules;
  v_subject  uuid;
  v_subjects uuid[];
  v_eval     record;
BEGIN
  IF p_org_id IS NULL THEN RETURN; END IF;

  IF p_scope IN ('employee','run') THEN
    v_subjects := COALESCE(p_subject_ids, ARRAY[]::uuid[]);
    IF array_length(v_subjects, 1) IS NULL THEN RETURN; END IF;
  ELSE
    v_subjects := ARRAY[NULL::uuid];
  END IF;

  FOR v_rule IN
    SELECT * FROM public.payroll_readiness_rules
    WHERE is_active = true
      AND scope = p_scope
      AND (organization_id IS NULL OR organization_id = p_org_id)
    ORDER BY sort_order, code
  LOOP
    FOREACH v_subject IN ARRAY v_subjects LOOP
      FOR v_eval IN
        SELECT * FROM public.payroll_readiness_eval_rule(
          v_rule, p_org_id, p_business_id, v_subject, p_period_start, p_period_end
        )
      LOOP
        INSERT INTO public.payroll_readiness_findings (
          organization_id, business_id, rule_id, subject_type, subject_id,
          status, reason, missing_fields, details, evaluated_at
        ) VALUES (
          p_org_id, p_business_id, v_rule.id, p_scope, v_subject,
          v_eval.out_status, v_eval.out_reason, v_eval.out_missing_fields, v_eval.out_details, now()
        )
        ON CONFLICT (
          organization_id,
          COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid),
          subject_type,
          COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
          rule_id
        )
        DO UPDATE SET
          status         = EXCLUDED.status,
          reason         = EXCLUDED.reason,
          missing_fields = EXCLUDED.missing_fields,
          details        = EXCLUDED.details,
          evaluated_at   = EXCLUDED.evaluated_at;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$function$;

-- 2. Provisioning triggers skip drafts; fire on draft -> active --------------

-- 2a. auto_create_employment_on_employee_insert
CREATE OR REPLACE FUNCTION public.auto_create_employment_on_employee_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.lifecycle_status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.lifecycle_status,'') <> 'draft' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.employments WHERE employee_id = NEW.id) THEN
    INSERT INTO public.employments (
      organization_id, business_id, branch_id, employee_id,
      start_date, end_date, employment_type, status,
      termination_type, is_primary
    )
    VALUES (
      NEW.organization_id,
      NEW.business_id,
      NEW.branch_id,
      NEW.id,
      COALESCE(NEW.hire_date, CURRENT_DATE),
      CASE WHEN NEW.is_active = FALSE THEN NEW.termination_date END,
      COALESCE(NEW.employment_type, 'full_time'),
      CASE WHEN NEW.is_active = FALSE THEN 'terminated' ELSE 'active' END,
      CASE WHEN NEW.is_active = FALSE THEN 'other' END,
      TRUE
    );
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS employees_auto_employment ON public.employees;
CREATE TRIGGER employees_auto_employment
  AFTER INSERT OR UPDATE OF lifecycle_status ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_create_employment_on_employee_insert();

-- 2b. auto_create_default_onboarding
CREATE OR REPLACE FUNCTION public.auto_create_default_onboarding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_template_id   uuid;
  v_onboarding_id uuid;
BEGIN
  IF NEW.lifecycle_status = 'draft' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.lifecycle_status,'') <> 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_template_id
  FROM public.onboarding_templates
  WHERE organization_id = NEW.organization_id
    AND is_default = true
    AND is_active = true
    AND (NEW.business_id IS NULL OR business_id IS NULL OR business_id = NEW.business_id)
  ORDER BY (business_id = NEW.business_id) DESC NULLS LAST, created_at ASC
  LIMIT 1;

  IF v_template_id IS NULL THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.employee_onboarding WHERE employee_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.employee_onboarding (
    organization_id, business_id, employee_id, template_id, onboarding_type, status
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.id, v_template_id, 'new_hire', 'pending'
  )
  RETURNING id INTO v_onboarding_id;

  INSERT INTO public.employee_onboarding_items (
    onboarding_id, template_item_id, title, description, category, sort_order
  )
  SELECT v_onboarding_id, ti.id, ti.title, ti.description, ti.category, ti.sort_order
  FROM public.onboarding_template_items ti
  WHERE ti.template_id = v_template_id
  ORDER BY ti.sort_order;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_auto_create_default_onboarding ON public.employees;
CREATE TRIGGER trg_auto_create_default_onboarding
  AFTER INSERT OR UPDATE OF lifecycle_status ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_create_default_onboarding();

-- 2c. hr_apply_default_onboarding
CREATE OR REPLACE FUNCTION public.hr_apply_default_onboarding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tpl           uuid;
  v_onboarding_id uuid;
BEGIN
  IF NEW.lifecycle_status = 'draft' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.lifecycle_status,'') <> 'draft' THEN
    RETURN NEW;
  END IF;

  SELECT default_onboarding_template_id INTO v_tpl
    FROM public.hr_policies
   WHERE business_id = NEW.business_id;

  INSERT INTO public.employee_onboarding (
    organization_id, business_id, employee_id, template_id,
    onboarding_type, status, started_at
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.id, v_tpl,
    'onboarding', 'in_progress', now()
  )
  RETURNING id INTO v_onboarding_id;

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

  INSERT INTO public.employee_onboarding_items (
    onboarding_id, title, description, category, sort_order, is_completed
  )
  SELECT
    v_onboarding_id,
    'Collect ' || COALESCE(req.label, req.requirement_key),
    COALESCE(req.help_text,
      'Required statutory identifier (' || req.requirement_key || ').'),
    'statutory',
    1000 + req.sort_order,
    false
  FROM (
    SELECT DISTINCT ON (requirement_key)
      requirement_key, label, help_text, sort_order, is_active, blocks_onboarding
    FROM public.pack_requirements
    WHERE business_id = NEW.business_id
      AND scope = 'statutory_identifier'
    ORDER BY requirement_key,
      CASE source WHEN 'tenant_override' THEN 0 ELSE 1 END
  ) req
  WHERE req.is_active = true
    AND req.blocks_onboarding = true
    AND NOT EXISTS (
      SELECT 1 FROM public.employee_statutory_identifiers esi
       WHERE esi.employee_id = NEW.id
         AND esi.identifier_type = req.requirement_key
         AND COALESCE(esi.identifier_value, '') <> ''
    );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'hr_apply_default_onboarding skipped for employee %: %', NEW.id, sqlerrm;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_hr_apply_default_onboarding ON public.employees;
CREATE TRIGGER trg_hr_apply_default_onboarding
  AFTER INSERT OR UPDATE OF lifecycle_status ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.hr_apply_default_onboarding();

-- 2d. fn_record_employee_position_change
CREATE OR REPLACE FUNCTION public.fn_record_employee_position_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.lifecycle_status = 'draft' THEN RETURN NEW; END IF;
    INSERT INTO public.employee_position_history(
      organization_id, employee_id, effective_from,
      department_id, branch_id, job_position_id, manager_id, employment_type,
      change_reason, changed_by
    ) VALUES (
      NEW.organization_id, NEW.id, now(),
      NEW.department_id, NEW.branch_id, NEW.job_position_id, NEW.manager_id, NEW.employment_type,
      'initial', auth.uid()
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.lifecycle_status,'') = 'draft'
     AND NEW.lifecycle_status <> 'draft' THEN
    INSERT INTO public.employee_position_history(
      organization_id, employee_id, effective_from,
      department_id, branch_id, job_position_id, manager_id, employment_type,
      change_reason, changed_by
    ) VALUES (
      NEW.organization_id, NEW.id, now(),
      NEW.department_id, NEW.branch_id, NEW.job_position_id, NEW.manager_id, NEW.employment_type,
      'initial', auth.uid()
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.lifecycle_status <> 'draft'
     AND (
       NEW.department_id   IS DISTINCT FROM OLD.department_id   OR
       NEW.branch_id       IS DISTINCT FROM OLD.branch_id       OR
       NEW.job_position_id IS DISTINCT FROM OLD.job_position_id OR
       NEW.manager_id      IS DISTINCT FROM OLD.manager_id      OR
       NEW.employment_type IS DISTINCT FROM OLD.employment_type
     ) THEN
    INSERT INTO public.employee_position_history(
      organization_id, employee_id, effective_from,
      department_id, branch_id, job_position_id, manager_id, employment_type,
      prev_department_id, prev_branch_id, prev_job_position_id, prev_manager_id, prev_employment_type,
      change_reason, changed_by
    ) VALUES (
      NEW.organization_id, NEW.id, now(),
      NEW.department_id, NEW.branch_id, NEW.job_position_id, NEW.manager_id, NEW.employment_type,
      OLD.department_id, OLD.branch_id, OLD.job_position_id, OLD.manager_id, OLD.employment_type,
      'update', auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$function$;

-- 2e. trg_reeval_employee_self_readiness
CREATE OR REPLACE FUNCTION public.trg_reeval_employee_self_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_emp       uuid;
  v_org       uuid;
  v_biz       uuid;
  v_lifecycle text;
BEGIN
  v_emp := COALESCE(NEW.id, OLD.id);
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  v_biz := COALESCE(NEW.business_id, OLD.business_id);
  v_lifecycle := COALESCE(NEW.lifecycle_status, OLD.lifecycle_status);

  IF v_org IS NULL OR v_emp IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org) THEN RETURN NULL; END IF;

  -- Drafts do not participate in payroll; skip readiness evaluation entirely.
  IF v_lifecycle = 'draft' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'org', NULL, NULL, NULL);
  ELSE
    PERFORM public.evaluate_payroll_readiness_quiet(v_org, v_biz, 'employee', ARRAY[v_emp], NULL, NULL);
  END IF;
  RETURN NULL;
END;
$function$;