CREATE OR REPLACE FUNCTION public.resolve_project_billing_rate(
  _project_id uuid,
  _employee_id uuid DEFAULT NULL::uuid,
  _explicit numeric DEFAULT NULL::numeric
)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH mem AS (
    SELECT pm.billable_rate, pm.is_billable_participant
      FROM public.project_members pm
      JOIN public.employees e ON e.id = _employee_id
     WHERE pm.project_id = _project_id
       AND pm.user_id = e.user_id
     LIMIT 1
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM mem WHERE is_billable_participant IS FALSE) THEN 0
    ELSE COALESCE(
      _explicit,
      (SELECT billable_rate FROM mem),
      (SELECT COALESCE(p.default_billable_rate, p.hourly_rate)
         FROM public.projects p WHERE p.id = _project_id)
    )
  END::numeric;
$function$;