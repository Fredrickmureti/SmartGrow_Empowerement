CREATE OR REPLACE FUNCTION public.trg_employments_readiness()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_org uuid; v_emp uuid;
BEGIN
  v_org := COALESCE(NEW.organization_id, OLD.organization_id);
  v_emp := COALESCE(NEW.employee_id, OLD.employee_id);
  IF v_org IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM public.evaluate_payroll_readiness_quiet(
    v_org,
    NULL::uuid,
    'employee',
    CASE WHEN v_emp IS NULL THEN NULL::uuid[] ELSE ARRAY[v_emp] END,
    NULL::date,
    NULL::date
  );
  RETURN COALESCE(NEW, OLD);
END;
$function$;