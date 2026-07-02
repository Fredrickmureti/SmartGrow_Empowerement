
CREATE OR REPLACE FUNCTION public.hr_apply_default_onboarding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tpl uuid;
  v_onboarding_id uuid;
BEGIN
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

  -- Required statutory-field items sourced from pack_requirements
  -- (tenant_override rows win over pack defaults via DISTINCT ON priority).
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
