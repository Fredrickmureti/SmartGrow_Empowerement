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
    IF NEW.job_position_id IS DISTINCT FROM OLD.job_position_id THEN
      PERFORM public.emit_employee_lifecycle_event(
        NEW.organization_id, NEW.business_id, NEW.id,
        'position_changed', 'Position changed',
        jsonb_build_object('from', OLD.job_position_id, 'to', NEW.job_position_id),
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