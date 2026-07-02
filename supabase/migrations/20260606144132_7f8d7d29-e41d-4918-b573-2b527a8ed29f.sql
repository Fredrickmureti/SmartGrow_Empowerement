
-- Allow employees to read their own onboarding
CREATE POLICY employee_onboarding_select_own ON public.employee_onboarding
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = employee_onboarding.employee_id
      AND e.user_id = auth.uid()
  )
);

-- Allow employees to read their own onboarding items
CREATE POLICY employee_onboarding_items_select_own ON public.employee_onboarding_items
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.employee_onboarding o
    JOIN public.employees e ON e.id = o.employee_id
    WHERE o.id = employee_onboarding_items.onboarding_id
      AND e.user_id = auth.uid()
  )
);

-- Allow employees to tick / untick their own onboarding items (limited UPDATE)
CREATE POLICY employee_onboarding_items_update_own ON public.employee_onboarding_items
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.employee_onboarding o
    JOIN public.employees e ON e.id = o.employee_id
    WHERE o.id = employee_onboarding_items.onboarding_id
      AND e.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.employee_onboarding o
    JOIN public.employees e ON e.id = o.employee_id
    WHERE o.id = employee_onboarding_items.onboarding_id
      AND e.user_id = auth.uid()
  )
);

-- Auto-instantiate onboarding from the default template when a new employee
-- is created. Skips if no default template exists for the org or if an
-- onboarding record already exists for this employee.
CREATE OR REPLACE FUNCTION public.auto_create_default_onboarding()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_template_id uuid;
  v_onboarding_id uuid;
BEGIN
  -- Find a default template for this org (prefer the one matching the business if set)
  SELECT id INTO v_template_id
  FROM public.onboarding_templates
  WHERE organization_id = NEW.organization_id
    AND is_default = true
    AND is_active = true
    AND (NEW.business_id IS NULL OR business_id IS NULL OR business_id = NEW.business_id)
  ORDER BY (business_id = NEW.business_id) DESC NULLS LAST, created_at ASC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if onboarding already exists for this employee
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
$$;

DROP TRIGGER IF EXISTS trg_auto_create_default_onboarding ON public.employees;
CREATE TRIGGER trg_auto_create_default_onboarding
AFTER INSERT ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.auto_create_default_onboarding();
