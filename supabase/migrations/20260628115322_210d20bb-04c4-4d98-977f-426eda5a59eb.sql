CREATE OR REPLACE FUNCTION public.tg_employees_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_was_archived boolean;
  v_is_archived  boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.emit_employee_lifecycle_event(
      NEW.organization_id, NEW.business_id, NEW.id,
      'hired', 'Employee record created',
      jsonb_build_object('hire_date', NEW.hire_date),
      'employees', NEW.id, NEW.hire_date, NULL
    );
  ELSIF TG_OP = 'UPDATE' THEN
    v_was_archived := (OLD.lifecycle_status::text = 'archived');
    v_is_archived  := (NEW.lifecycle_status::text = 'archived');

    IF v_is_archived IS DISTINCT FROM v_was_archived THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        CASE WHEN v_is_archived THEN 'archived' ELSE 'unarchived' END,
        CASE WHEN v_is_archived THEN 'Employee archived' ELSE 'Employee unarchived' END,
        '{}'::jsonb, 'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.department_id IS DISTINCT FROM OLD.department_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'department_transferred', 'Department changed',
        jsonb_build_object('from', OLD.department_id, 'to', NEW.department_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.manager_id IS DISTINCT FROM OLD.manager_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'manager_changed', 'Manager changed',
        jsonb_build_object('from', OLD.manager_id, 'to', NEW.manager_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.position_id IS DISTINCT FROM OLD.position_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'position_changed', 'Position changed',
        jsonb_build_object('from', OLD.position_id, 'to', NEW.position_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
    IF NEW.work_location_id IS DISTINCT FROM OLD.work_location_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'location_transferred', 'Work location changed',
        jsonb_build_object('from', OLD.work_location_id, 'to', NEW.work_location_id),
        'employees', NEW.id, NULL, NULL
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.close_department(p_department_id uuid)
RETURNS public.org_change_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_dept public.departments;
  v_active_count int;
  v_row public.org_change_log;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  SELECT * INTO v_dept FROM public.departments WHERE id = p_department_id;
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'Department not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = auth.uid() AND uba.organization_id = v_dept.organization_id
  ) THEN
    RAISE EXCEPTION 'Not authorized for this organization';
  END IF;

  -- Archival state lives on lifecycle_status; the legacy is_archived column
  -- was removed. Anything not archived/exited/terminated counts as active.
  SELECT COUNT(*) INTO v_active_count
  FROM public.employees
  WHERE department_id = p_department_id
    AND lifecycle_status::text NOT IN ('archived','exited','terminated');

  IF v_active_count > 0 THEN
    RAISE EXCEPTION 'Cannot close department: % active employees still assigned. Reassign or merge first.', v_active_count;
  END IF;

  BEGIN
    EXECUTE 'UPDATE public.departments SET is_active = false, updated_at = now() WHERE id = $1'
      USING p_department_id;
  EXCEPTION WHEN undefined_column THEN
    NULL;
  END;

  INSERT INTO public.org_change_log (
    organization_id, business_id, entity_kind, entity_id, change_kind,
    actor_user_id, summary, payload
  ) VALUES (
    v_dept.organization_id, v_dept.business_id, 'department', p_department_id, 'department_closed',
    auth.uid(), format('Closed department "%s"', v_dept.name),
    jsonb_build_object('name', v_dept.name)
  ) RETURNING * INTO v_row;
  RETURN v_row;
END;
$function$;