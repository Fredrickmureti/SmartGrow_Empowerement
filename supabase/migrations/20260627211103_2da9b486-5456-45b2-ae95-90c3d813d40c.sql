-- Fix enum-coercion crash in lifecycle-gated triggers.
-- `COALESCE(OLD.lifecycle_status, '')` forces the empty-string literal to be
-- cast to enum `employee_lifecycle_status`, which fails with SQLSTATE 22P02
-- ("invalid input value for enum ...: \"\""). The cure is to coerce the enum
-- to text first so the COALESCE/equality comparison happens in text space.

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
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.lifecycle_status::text, '') <> 'draft' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.employments WHERE employee_id = NEW.id) THEN
    INSERT INTO public.employments (
      organization_id, business_id, branch_id, employee_id,
      start_date, end_date, employment_type, status,
      termination_type, is_primary
    )
    VALUES (
      NEW.organization_id, NEW.business_id, NEW.branch_id, NEW.id,
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
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.lifecycle_status::text, '') <> 'draft' THEN
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
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.lifecycle_status::text, '') <> 'draft' THEN
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
     AND COALESCE(OLD.lifecycle_status::text, '') = 'draft'
     AND NEW.lifecycle_status::text <> 'draft' THEN
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
     AND NEW.lifecycle_status::text <> 'draft'
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
      change_reason, changed_by
    ) VALUES (
      NEW.organization_id, NEW.id, now(),
      NEW.department_id, NEW.branch_id, NEW.job_position_id, NEW.manager_id, NEW.employment_type,
      'position_change', auth.uid()
    );
  END IF;

  RETURN NEW;
END;
$function$;