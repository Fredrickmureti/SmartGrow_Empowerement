CREATE OR REPLACE FUNCTION public.is_org_admin_or_owner(_user_id uuid, _organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.is_org_administrator(_user_id, _organization_id);
$function$;