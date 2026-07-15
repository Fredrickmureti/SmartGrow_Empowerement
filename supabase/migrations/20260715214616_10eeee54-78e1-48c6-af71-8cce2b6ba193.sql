CREATE OR REPLACE FUNCTION public.enforce_employee_user_link_write_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source text := current_setting('app.identity_change_source', true);
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.user_id IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    IF COALESCE(v_source, '') NOT IN (
      'accept_organization_invitation_atomic',
      'link_employee_to_user',
      'unlink_employee_from_user',
      'link_self_as_employee'
    ) THEN
      RAISE EXCEPTION 'employees.user_id may only be changed through the employee identity lifecycle RPCs'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_employee_user_link_write_source ON public.employees;
CREATE TRIGGER trg_enforce_employee_user_link_write_source
BEFORE INSERT OR UPDATE OF user_id ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.enforce_employee_user_link_write_source();

CREATE OR REPLACE FUNCTION public.link_self_as_employee()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_org_id uuid;
  v_business_id uuid;
  v_email text;
  v_first text;
  v_last text;
  v_emp_number text;
  v_emp_id uuid;
  v_existing uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;

  SELECT o.id INTO v_org_id
    FROM public.organizations o
    JOIN public.user_roles ur ON ur.organization_id = o.id
   WHERE ur.user_id = v_user AND ur.is_active = true
     AND ur.role IN ('owner','admin','super_admin')
   ORDER BY o.created_at ASC LIMIT 1;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Only workspace owners or admins can self-link as an employee.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT id INTO v_business_id
    FROM public.businesses
   WHERE organization_id = v_org_id AND is_active = true
   ORDER BY created_at ASC LIMIT 1;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'No active business found for this workspace.';
  END IF;

  SELECT id INTO v_existing FROM public.employees
   WHERE organization_id = v_org_id AND user_id = v_user LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user;
  SELECT
    COALESCE(NULLIF(split_part(p.full_name, ' ', 1), ''), 'Owner'),
    NULLIF(regexp_replace(COALESCE(p.full_name, ''), '^\S+\s*', ''), '')
    INTO v_first, v_last
  FROM public.profiles p WHERE p.user_id = v_user;

  v_first := COALESCE(v_first, 'Owner');
  SELECT public.get_next_employee_number(v_org_id, v_business_id) INTO v_emp_number;

  PERFORM set_config('app.identity_change_source','link_self_as_employee', true);

  INSERT INTO public.employees (
    organization_id, business_id, employee_number,
    first_name, last_name, email, user_id,
    position, hire_date, employment_type, is_active
  ) VALUES (
    v_org_id, v_business_id, COALESCE(v_emp_number, 'EMP-0001'),
    v_first, v_last, v_email, v_user,
    'Owner / Founder', CURRENT_DATE, 'full_time', true
  ) RETURNING id INTO v_emp_id;

  PERFORM set_config('app.identity_change_source','', true);

  UPDATE public.onboarding_suggestions
     SET status = 'accepted', resolved_at = now(), resolved_by = v_user
   WHERE organization_id = v_org_id AND kind = 'link_owner_as_employee';

  RETURN v_emp_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.identity_change_source','', true);
  RAISE;
END;
$function$;